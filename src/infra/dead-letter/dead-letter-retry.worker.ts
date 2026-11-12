import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeadLetterConfig } from '../../config/configuration';
import { DeadLetterStatus } from '../database/entities/dead-letter-status.enum';
import { OrderDeadLetterEntity } from '../database/entities/order-dead-letter.entity';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../kafka/order-events.producer';
import { OrderDeadLetterRepository } from '../../repositories/order-dead-letter.repository';
import { ConsumedMessageDeadLetterEntity } from '../database/entities/consumed-message-dead-letter.entity';
import { ConsumedMessageDeadLetterRepository } from '../../repositories/consumed-message-dead-letter.repository';
import { PaymentEventsConsumer } from '../kafka/payment-events.consumer';
import { OrderProjectionConsumer } from '../kafka/order-projection.consumer';
import { MalformedMessageError } from '../kafka/malformed-message.error';
import { AttemptResult, RetryUpdate, decideRetry } from './retry-policy';

/** Injection token for the worker's clock; defaults to `() => new Date()`. */
export const DEAD_LETTER_CLOCK = Symbol('DEAD_LETTER_CLOCK');

/** The topics this service produces, and so the only ones an outbound row may target. */
const OUTBOUND_TOPICS: ReadonlySet<string> = new Set([
  ORDER_PLACED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_CANCELLED_TOPIC,
]);

/** A consumer that can re-handle one stored message (parse + handle, no retry or commit). */
interface InboundHandler {
  readonly topics: readonly string[];
  process(topic: string, value: Buffer | null): Promise<void>;
}

type Kind = 'outbound' | 'inbound';
type ClaimNext<T> = (handler: (row: T) => Promise<RetryUpdate>) => Promise<boolean>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Background worker that retries dead letters (US-08).
 *
 * Runs on a self-rescheduling timer: each cycle runs to completion and then schedules the next
 * one after `intervalMs`, so cycles never overlap. Startup never waits for a cycle, and shutdown
 * waits for at most the attempt in flight. Each row is claimed and updated in its own transaction
 * (`processNextDue`, `FOR UPDATE SKIP LOCKED`), so several instances can run side by side.
 *
 * - Outbound rows (`order_dead_letters`) are republished through OrderEventsProducer with the
 *   same `eventId`.
 * - Inbound rows (`consumed_message_dead_letters`) are re-handled by the consumer that owns the
 *   topic (`process()`), so the same parsing and idempotency rules apply as for live messages.
 *   Retries never commit offsets and never create new dead letters.
 *
 * Infrastructure orchestration only: the retry rules live in the pure `retry-policy`, business
 * rules in the handlers it calls.
 */
@Injectable()
export class DeadLetterRetryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterRetryWorker.name);
  private readonly settings: DeadLetterConfig;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private readonly inboundHandlers: readonly InboundHandler[];

  constructor(
    config: ConfigService,
    private readonly outbound: OrderDeadLetterRepository,
    private readonly inbound: ConsumedMessageDeadLetterRepository,
    private readonly producer: OrderEventsProducer,
    paymentConsumer: PaymentEventsConsumer,
    projectionConsumer: OrderProjectionConsumer,
    @Optional() @Inject(DEAD_LETTER_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {
    this.settings = config.getOrThrow<DeadLetterConfig>('deadLetter');
    this.inboundHandlers = [paymentConsumer, projectionConsumer];
  }

  /** Schedules the first cycle after one interval. Never blocks startup. */
  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      this.logger.log('Dead-letter retry is disabled (DEAD_LETTER_RETRY_ENABLED=false)');
      return;
    }
    this.scheduleNext();
  }

  /** Stops scheduling and waits for the cycle in flight, which stops before its next row. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  /**
   * One retry cycle: drains up to `batchSize` due rows from each store. Never throws: a database
   * failure is logged and the next cycle tries again.
   */
  async runCycle(): Promise<void> {
    const outbound = await this.drain<OrderDeadLetterEntity>(
      'outbound',
      (handler) => this.outbound.processNextDue(handler),
      (row) => this.retryOutbound(row),
    );
    const inbound = await this.drain<ConsumedMessageDeadLetterEntity>(
      'inbound',
      (handler) => this.inbound.processNextDue(handler),
      (row) => this.retryInbound(row),
    );
    if (outbound + inbound > 0) {
      this.logger.debug(
        `Dead-letter retry cycle: ${outbound} outbound and ${inbound} inbound row(s) attempted`,
      );
    }
  }

  private scheduleNext(): void {
    if (this.stopping) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }, this.settings.intervalMs);
    this.timer.unref();
  }

  /** Claims and processes rows one at a time until none is due, the batch is full or we stop. */
  private async drain<T>(
    kind: Kind,
    claimNext: ClaimNext<T>,
    retry: (row: T) => Promise<RetryUpdate>,
  ): Promise<number> {
    let attempted = 0;
    try {
      while (attempted < this.settings.batchSize && !this.stopping) {
        if (!(await claimNext(retry))) {
          break;
        }
        attempted++;
      }
    } catch (error) {
      this.logger.error(`Dead-letter retry cycle failed (${kind}): ${messageOf(error)}`);
    }
    return attempted;
  }

  private async retryOutbound(row: OrderDeadLetterEntity): Promise<RetryUpdate> {
    const result = await this.attemptOutbound(row);
    const update = decideRetry(row, result, this.now(), this.settings);
    this.report('outbound', row, update);
    return update;
  }

  private async attemptOutbound(row: OrderDeadLetterEntity): Promise<AttemptResult> {
    if (!OUTBOUND_TOPICS.has(row.topic)) {
      return { kind: 'permanent', error: `Unknown outbound topic "${row.topic}"` };
    }
    const { eventId, aggregateId } = row.payload;
    if (typeof eventId !== 'string' || typeof aggregateId !== 'string') {
      return { kind: 'permanent', error: 'Stored payload has no string eventId/aggregateId' };
    }
    try {
      await this.producer.republish(row.topic, row.payload);
      return { kind: 'success' };
    } catch (error) {
      return { kind: 'transient', error: messageOf(error) };
    }
  }

  private async retryInbound(row: ConsumedMessageDeadLetterEntity): Promise<RetryUpdate> {
    const result = await this.attemptInbound(row);
    const update = decideRetry(row, result, this.now(), this.settings);
    this.report('inbound', row, update);
    return update;
  }

  private async attemptInbound(row: ConsumedMessageDeadLetterEntity): Promise<AttemptResult> {
    const handler = this.inboundHandlers.find((candidate) => candidate.topics.includes(row.topic));
    if (handler === undefined) {
      return { kind: 'permanent', error: `No consumer handles topic "${row.topic}"` };
    }
    if (row.rawValue === null) {
      return { kind: 'permanent', error: 'Stored message has no value (tombstone)' };
    }
    try {
      await handler.process(row.topic, Buffer.from(row.rawValue, 'utf8'));
      return { kind: 'success' };
    } catch (error) {
      const kind = error instanceof MalformedMessageError ? 'permanent' : 'transient';
      return { kind, error: messageOf(error) };
    }
  }

  private report(
    kind: Kind,
    row: OrderDeadLetterEntity | ConsumedMessageDeadLetterEntity,
    update: RetryUpdate,
  ): void {
    const orderId = 'orderId' in row ? `, orderId ${row.orderId ?? '-'}` : '';
    const context =
      `${kind} dead letter ${row.id} (topic ${row.topic}, eventId ${row.eventId ?? '-'}` +
      `${orderId}, retryCount ${update.retryCount})`;
    if (update.status === DeadLetterStatus.RESOLVED) {
      this.logger.log(`Resolved ${context}`);
    } else if (update.status === DeadLetterStatus.EXHAUSTED) {
      this.logger.error(`Gave up on ${context}: ${update.lastError}`);
    } else {
      this.logger.warn(
        `Retry failed for ${context}, next at ${update.nextRetryAt.toISOString()}: ` +
          `${update.lastError}`,
      );
    }
  }
}
