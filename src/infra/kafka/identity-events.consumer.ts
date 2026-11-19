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
import { CreateCustomerCommand } from '../../commands/create-customer.command';
import { ConsumedMessageDeadLetterRepository } from '../../repositories/consumed-message-dead-letter.repository';
import { consumeWithDeadLetter } from './consume-with-dead-letter';
import { KafkaConnectLoop } from './kafka-connect-loop';
import { KAFKA_CLIENT } from './kafka.constants';
import {
  USER_REGISTERED_TOPIC,
  ParsedUserRegisteredMessage,
  parseUserRegisteredMessage,
} from './user-registered-message.parser';

/**
 * Inbound adapter for `identity.user-registered`, published by ecommerce-identity (US-10). Like
 * a controller, it only does I/O: it validates each message, dispatches CreateCustomerCommand,
 * and commits the offset manually — only after the customer and its processed-event record have
 * been saved. The customer is the one named by the message's `customerId`; its `aggregateId` is
 * the user id and never a customer id. Business rules live in the domain (`Customer.register`).
 *
 * Failure handling is the payment consumer's: malformed messages are dead-lettered at once;
 * any other failure (e.g. a database outage) is retried with exponential
 * backoff and then dead-lettered as retryable, for the dead-letter retry worker to replay.
 * Either way the offset is committed after the dead-letter row is saved. If the dead-letter
 * write itself fails, nothing is committed and the message is redelivered.
 */
@Injectable()
export class IdentityEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IdentityEventsConsumer.name);
  private readonly config: KafkaConfig;
  private readonly consumer: Consumer;
  private readonly connectLoop: KafkaConnectLoop;

  /** The topics this consumer owns (also used to route inbound dead-letter retries). */
  readonly topics: readonly string[] = [USER_REGISTERED_TOPIC];

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
    this.consumer = kafka.consumer({ groupId: config.identityGroupId });
    this.connectLoop = new KafkaConnectLoop({
      name: 'identity events consumer',
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
      this.logger.log('identity events consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
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
      `identity events consumer running (group ${this.config.identityGroupId}, topics ` +
        `${USER_REGISTERED_TOPIC})`,
    );
  }

  /**
   * Handles one consumed message: parse and validate it, dispatch the registration (retrying
   * with backoff), and commit `offset + 1` once the result — a created customer, a no-op record
   * or a dead-letter row — has been saved. See consumeWithDeadLetter for the shared flow.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    await consumeWithDeadLetter<ParsedUserRegisteredMessage>(payload, {
      parse: parseUserRegisteredMessage,
      describe: (parsed) => ({ eventId: parsed.eventId }),
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
    await this.handle(parseUserRegisteredMessage(topic, value));
  }

  private handle(parsed: ParsedUserRegisteredMessage): Promise<unknown> {
    return this.commandBus.execute(
      new CreateCustomerCommand(parsed.customerId, parsed.name, parsed.email, {
        eventId: parsed.eventId,
        topic: USER_REGISTERED_TOPIC,
        customerId: parsed.customerId,
      }),
    );
  }
}
