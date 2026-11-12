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
import { ConsumedMessageDeadLetterRepository } from '../../repositories/consumed-message-dead-letter.repository';
import { consumeWithDeadLetter } from './consume-with-dead-letter';
import { KafkaConnectLoop } from './kafka-connect-loop';
import { KAFKA_CLIENT } from './kafka.constants';
import {
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
  ParsedPaymentMessage,
  parsePaymentMessage,
} from './payment-message.parser';

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
  private readonly connectLoop: KafkaConnectLoop;

  /** The topics this consumer owns (also used to route inbound dead-letter retries). */
  readonly topics: readonly string[] = [PAYMENT_PROCESSED_TOPIC, PAYMENT_FAILED_TOPIC];

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
    this.connectLoop = new KafkaConnectLoop({
      name: 'payment events consumer',
      connect: (): Promise<void> => this.start(),
      initialMs: config.backoffInitialMs,
      maxMs: config.backoffMaxMs,
      logger: this.logger,
    });
  }

  /**
   * Connects, subscribes and runs in the background, so a Kafka outage never blocks startup.
   * A failed connect is retried with capped exponential backoff (`KafkaConnectLoop`) until it
   * succeeds or the application shuts down. Started on bootstrap rather than module init, so
   * the CQRS command handlers are registered before the first message is dispatched. Does
   * nothing when KAFKA_CONSUMER_ENABLED=false.
   */
  onApplicationBootstrap(): void {
    if (!this.config.consumerEnabled) {
      this.logger.log('payment events consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
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
      `payment events consumer running (group ${this.config.groupId}, topics ` +
        `${PAYMENT_PROCESSED_TOPIC}, ${PAYMENT_FAILED_TOPIC})`,
    );
  }

  /**
   * Handles one consumed message: parse and validate it, dispatch the reaction (retrying with
   * backoff), and commit `offset + 1` once the outcome — a state change, a no-op record or a
   * dead-letter row — has been saved. See consumeWithDeadLetter for the shared flow.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    await consumeWithDeadLetter<ParsedPaymentMessage>(payload, {
      parse: parsePaymentMessage,
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
    await this.handle(parsePaymentMessage(topic, value));
  }

  private handle(parsed: ParsedPaymentMessage): Promise<unknown> {
    return this.commandBus.execute(
      new ReactToPaymentOutcomeCommand(parsed.outcome, parsed.inboundEvent, parsed.reason),
    );
  }
}
