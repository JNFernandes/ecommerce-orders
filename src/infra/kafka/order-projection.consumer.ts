import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { KafkaConfig } from '../../config/configuration';
import { OrderEvent } from '../../read-model/order-event';
import { OrderProjectionService } from '../../read-model/order-projection.service';
import { ReadModelUnavailableError } from '../../read-model/errors';
import { ConsumedMessageDeadLetterRepository } from '../../repositories/consumed-message-dead-letter.repository';
import { KAFKA_CLIENT } from './kafka.constants';
import { consumeWithDeadLetter } from './consume-with-dead-letter';
import { ORDER_EVENT_TOPICS, parseOrderEventMessage } from './order-event-message.parser';

/**
 * Inbound adapter for the read-model projection: consumes this service's own order events
 * (`orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled`) in its own consumer
 * group (KAFKA_PROJECTION_GROUP_ID, from the earliest offset so existing orders are backfilled)
 * and hands each validated event to OrderProjectionService. Offsets are committed manually,
 * only after the MongoDB write (or the dead-letter row) is saved.
 */
@Injectable()
export class OrderProjectionConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderProjectionConsumer.name);
  private readonly config: KafkaConfig;
  private readonly consumer: Consumer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    configService: ConfigService,
    private readonly projectionService: OrderProjectionService,
    private readonly deadLetters: ConsumedMessageDeadLetterRepository,
  ) {
    const config = configService.get<KafkaConfig>('kafka');
    if (!config) {
      throw new Error('kafka configuration is missing');
    }
    this.config = config;
    this.consumer = kafka.consumer({ groupId: config.projectionGroupId });
  }

  /**
   * Starts consuming in the background so neither Kafka nor MongoDB being down blocks HTTP
   * startup. Does nothing when KAFKA_CONSUMER_ENABLED=false.
   */
  onApplicationBootstrap(): void {
    if (!this.config.consumerEnabled) {
      this.logger.log('order projection consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
      return;
    }
    void this.start().catch((error: Error) => {
      this.logger.error(`order projection consumer failed to start: ${error.message}`, error.stack);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [...ORDER_EVENT_TOPICS], fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.handleMessage(payload),
    });
    this.logger.log(
      `order projection consumer running (group ${this.config.projectionGroupId}, topics ` +
        `${ORDER_EVENT_TOPICS.join(', ')})`,
    );
  }

  /**
   * Parses one order event, projects it (with retries), and commits `offset + 1`. Malformed
   * events and persistent failures are dead-lettered; a read-model outage is rethrown without
   * committing, so the event is redelivered once MongoDB is back.
   */
  async handleMessage(payload: EachMessagePayload): Promise<void> {
    await consumeWithDeadLetter<OrderEvent>(payload, {
      parse: parseOrderEventMessage,
      describe: (event) => ({ eventId: event.eventId, orderId: event.orderId }),
      handle: (event) => this.projectionService.project(event),
      // A MongoDB outage is not the event's fault: never dead-letter it. The offset stays
      // uncommitted, kafkajs restarts the consumer and the event is redelivered later.
      isFatal: (error) => error instanceof ReadModelUnavailableError,
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
}
