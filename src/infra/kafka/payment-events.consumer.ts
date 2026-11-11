import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { KafkaConfig } from '../../config/configuration';
import { ReactToPaymentOutcomeCommand } from '../../commands/react-to-payment-outcome.command';
import {
  ConsumedMessageDeadLetterRepository,
  ConsumedMessageMeta,
} from '../../repositories/consumed-message-dead-letter.repository';
import { KAFKA_CLIENT } from './kafka.constants';
import {
  MalformedPaymentMessageError,
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
  ParsedPaymentMessage,
  parsePaymentMessage,
} from './payment-message.parser';
import { RetriesExhaustedError, retryWithBackoff } from './retry-with-backoff';

/**
 * Inbound adapter for payment outcomes (`payments.payment-processed`, `payments.payment-failed`).
 * Like a controller, it only does I/O: it validates each message, dispatches
 * ReactToPaymentOutcomeCommand, and commits the offset manually — only after the outcome has
 * been durably saved. Business rules live in the domain (decidePaymentReaction).
 *
 * Failure handling: malformed messages are dead-lettered at once; any other failure is retried
 * with exponential backoff and then dead-lettered. Either way the offset is committed after the
 * dead-letter row is saved, so one bad message never blocks the partition. If the dead-letter
 * write itself fails, nothing is committed and the message is redelivered.
 */
@Injectable()
export class PaymentEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentEventsConsumer.name);
  private readonly config: KafkaConfig;
  private readonly consumer: Consumer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    private readonly commandBus: CommandBus,
    configService: ConfigService,
    private readonly deadLetters: ConsumedMessageDeadLetterRepository,
  ) {
    const config = configService.get<KafkaConfig>('kafka');
    if (!config) {
      throw new Error('kafka configuration is missing');
    }
    this.config = config;
    this.consumer = kafka.consumer({ groupId: config.groupId });
  }

  /**
   * Starts consuming in the background so a broker outage never blocks HTTP startup
   * (kafkajs keeps retrying the connection). Does nothing when KAFKA_CONSUMER_ENABLED=false.
   */
  onApplicationBootstrap(): void {
    if (!this.config.consumerEnabled) {
      this.logger.log('payment events consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
      return;
    }
    void this.start().catch((error: Error) => {
      this.logger.error(`payment events consumer failed to start: ${error.message}`, error.stack);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [PAYMENT_PROCESSED_TOPIC, PAYMENT_FAILED_TOPIC],
      fromBeginning: true,
    });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.handleMessage(payload),
    });
    this.logger.log(
      `payment events consumer running (group ${this.config.groupId}, topics ` +
        `${PAYMENT_PROCESSED_TOPIC}, ${PAYMENT_FAILED_TOPIC})`,
    );
  }

  /**
   * Handles one consumed message: parse and validate it, dispatch the reaction (retrying with
   * backoff), and commit `offset + 1` once the outcome — a state change, a no-op record or a
   * dead-letter row — has been saved.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const meta: ConsumedMessageMeta = {
      topic,
      partition,
      offset: message.offset,
      messageKey: message.key?.toString('utf8') ?? null,
      rawValue: message.value?.toString('utf8') ?? null,
    };

    let parsed: ParsedPaymentMessage;
    try {
      parsed = parsePaymentMessage(topic, message.value);
    } catch (error) {
      if (!(error instanceof MalformedPaymentMessageError)) {
        throw error;
      }
      const malformed = { ...meta, eventId: error.eventId, orderId: error.orderId };
      await this.deadLetters.recordMalformed(malformed, error);
      this.logger.warn(
        `dead-lettered malformed message (${error.message}); ${describe(malformed)}`,
      );
      await this.commit(payload);
      return;
    }

    const identified: ConsumedMessageMeta = {
      ...meta,
      eventId: parsed.inboundEvent.eventId,
      orderId: parsed.inboundEvent.orderId,
    };
    try {
      await retryWithBackoff(
        () =>
          this.commandBus.execute(
            new ReactToPaymentOutcomeCommand(parsed.outcome, parsed.inboundEvent, parsed.reason),
          ),
        {
          maxAttempts: this.config.maxAttempts,
          initialMs: this.config.backoffInitialMs,
          maxMs: this.config.backoffMaxMs,
          isRetryable: (error) => !(error instanceof MalformedPaymentMessageError),
          heartbeat: payload.heartbeat,
          onRetry: (attempt, error, delayMs) =>
            this.logger.warn(
              `attempt ${attempt}/${this.config.maxAttempts} failed (${messageOf(error)}), ` +
                `retrying in ${delayMs}ms; ${describe(identified)}`,
            ),
        },
      );
    } catch (error) {
      if (!(error instanceof RetriesExhaustedError)) {
        throw error;
      }
      await this.deadLetters.recordRetriesExhausted(identified, error.lastError, error.attempts);
      this.logger.error(
        `dead-lettered after ${error.attempts} attempts (${messageOf(error.lastError)}); ` +
          describe(identified),
      );
    }

    await this.commit(payload);
  }

  private async commit({ topic, partition, message }: EachMessagePayload): Promise<void> {
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(meta: ConsumedMessageMeta): string {
  return (
    `topic=${meta.topic} partition=${meta.partition} offset=${meta.offset} ` +
    `eventId=${meta.eventId ?? '-'} orderId=${meta.orderId ?? '-'}`
  );
}
