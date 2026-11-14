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
import { ApplyStockOutcomeCommand } from '../../commands/apply-stock-outcome.command';
import { ConsumedMessageDeadLetterRepository } from '../../repositories/consumed-message-dead-letter.repository';
import { consumeWithDeadLetter } from './consume-with-dead-letter';
import { KafkaConnectLoop } from './kafka-connect-loop';
import { KAFKA_CLIENT } from './kafka.constants';
import {
  STOCK_REJECTED_TOPIC,
  STOCK_RESERVED_TOPIC,
  ParsedStockMessage,
  parseStockMessage,
} from './stock-message.parser';

/**
 * Inbound adapter for stock outcomes published by ecommerce-inventory
 * (`inventory.stock-reserved`, `inventory.stock-rejected`). Like a controller, it only does
 * I/O: it validates each message, dispatches ApplyStockOutcomeCommand, and commits the offset
 * manually — only after the outcome has been durably saved. The order is the one named by the
 * message's `orderId`; its `aggregateId` is the reservation id and never an order id. Business
 * rules live in the domain (`Order.recordStock*()`).
 *
 * Failure handling is the payment consumer's: malformed messages are dead-lettered at once;
 * any other failure — an unknown order, or a database outage — is retried with exponential
 * backoff and then dead-lettered as retryable, for the dead-letter retry worker to replay.
 * Either way the offset is committed after the dead-letter row is saved. If the dead-letter
 * write itself fails, nothing is committed and the message is redelivered.
 */
@Injectable()
export class InventoryEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InventoryEventsConsumer.name);
  private readonly config: KafkaConfig;
  private readonly consumer: Consumer;
  private readonly connectLoop: KafkaConnectLoop;

  /** The topics this consumer owns (also used to route inbound dead-letter retries). */
  readonly topics: readonly string[] = [STOCK_RESERVED_TOPIC, STOCK_REJECTED_TOPIC];

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
    this.consumer = kafka.consumer({ groupId: config.inventoryGroupId });
    this.connectLoop = new KafkaConnectLoop({
      name: 'inventory events consumer',
      connect: (): Promise<void> => this.start(),
      initialMs: config.backoffInitialMs,
      maxMs: config.backoffMaxMs,
      logger: this.logger,
    });
  }

  /**
   * Connects, subscribes and runs in the background, so a Kafka outage never blocks startup.
   * A failed connect is retried with capped exponential backoff (`KafkaConnectLoop`) until it
   * succeeds or the application shuts down. Started on bootstrap, after the CQRS handlers are
   * registered. Does nothing when KAFKA_CONSUMER_ENABLED=false.
   */
  onApplicationBootstrap(): void {
    if (!this.config.consumerEnabled) {
      this.logger.log('inventory events consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
      return;
    }
    this.connectLoop.start();
  }

  /** Stops the connect loop, then disconnects. */
  async onApplicationShutdown(): Promise<void> {
    await this.connectLoop.stop();
    await this.consumer.disconnect();
  }

  /** One connect attempt; leaves the consumer disconnected if any step fails. */
  private async start(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topics: [...this.topics], fromBeginning: true });
      await this.consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handleMessage(payload),
      });
    } catch (error) {
      await this.consumer.disconnect().catch(() => undefined);
      throw error;
    }
    this.logger.log(
      `inventory events consumer running (group ${this.config.inventoryGroupId}, topics ` +
        `${STOCK_RESERVED_TOPIC}, ${STOCK_REJECTED_TOPIC})`,
    );
  }

  /**
   * Handles one consumed message: parse and validate it, dispatch the outcome (retrying with
   * backoff), and commit `offset + 1` once the result — a state change, an ignored-outcome
   * record or a dead-letter row — has been saved. See consumeWithDeadLetter for the shared flow.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    await consumeWithDeadLetter<ParsedStockMessage>(payload, {
      parse: parseStockMessage,
      describe: (parsed) => ({
        eventId: parsed.inboundEvent.eventId,
        orderId: parsed.inboundEvent.orderId,
      }),
      handle: (parsed) => this.handle(parsed),
      deadLetters: this.deadLetters,
      retry: {
        maxAttempts: this.config.maxAttempts,
        initialMs: this.config.backoffInitialMs,
        maxMs: this.config.backoffMaxMs,
      },
      commit: () =>
        this.consumer.commitOffsets([
          {
            topic: payload.topic,
            partition: payload.partition,
            offset: (BigInt(payload.message.offset) + 1n).toString(),
          },
        ]),
      logger: this.logger,
    });
  }

  /**
   * Parses and handles one message exactly once: no retry, no dead letter, no commit. Used by
   * the dead-letter retry worker, so retries go through the same parsing and the same
   * idempotent command as live consumption. Throws MalformedMessageError for poison messages.
   */
  async process(topic: string, value: Buffer | null): Promise<void> {
    await this.handle(parseStockMessage(topic, value));
  }

  private handle(parsed: ParsedStockMessage): Promise<unknown> {
    return this.commandBus.execute(
      new ApplyStockOutcomeCommand(parsed.outcome, parsed.inboundEvent, parsed.reason),
    );
  }
}
