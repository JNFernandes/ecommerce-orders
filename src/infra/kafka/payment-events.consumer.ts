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
import { KAFKA_CLIENT } from './kafka.constants';
import {
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
  parsePaymentMessage,
} from './payment-message.parser';

/**
 * Inbound adapter for payment outcomes (`payments.payment-processed`, `payments.payment-failed`).
 * Like a controller, it only does I/O: it validates each message, dispatches
 * ReactToPaymentOutcomeCommand, and commits the offset manually — only after the outcome has
 * been durably saved. Business rules live in the domain (decidePaymentReaction).
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
   * Handles one consumed message: parse and validate it, dispatch the reaction, then commit
   * `offset + 1`. If anything throws, the offset is not committed and the error propagates, so
   * kafkajs redelivers the message.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    const parsed = parsePaymentMessage(topic, message.value);
    await this.commandBus.execute(
      new ReactToPaymentOutcomeCommand(parsed.outcome, parsed.inboundEvent, parsed.reason),
    );

    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }
}
