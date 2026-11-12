import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Producer, ProducerRecord } from 'kafkajs';
import { KAFKA_PRODUCER } from './kafka.constants';
import { OrderPlaced } from '../../domain/events/order-placed.event';
import { OrderCancelled } from '../../domain/events/order-cancelled.event';
import { OrderConfirmed } from '../../domain/events/order-confirmed.event';

export const ORDER_PLACED_TOPIC = 'orders.order-placed';
export const ORDER_CANCELLED_TOPIC = 'orders.order-cancelled';
export const ORDER_CONFIRMED_TOPIC = 'orders.order-confirmed';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publishes Order domain events to Kafka. These `orders.*` topics are produced only by this
 * service (it also consumes payment events — see PaymentEventsConsumer).
 *
 * The producer connects **lazily**, on the first publish, so the service starts even when Kafka
 * is down. All publishes share one memoized connection attempt. If it fails, the memo is cleared
 * (the next publish tries again) and the error propagates to the caller, which dead-letters the
 * event as for any other publish failure. How long a failed attempt takes is bounded by
 * `KAFKA_CONNECTION_TIMEOUT_MS` and `KAFKA_PRODUCER_RETRIES` (see KafkaModule).
 */
@Injectable()
export class OrderEventsProducer implements OnApplicationShutdown {
  private readonly logger = new Logger(OrderEventsProducer.name);
  /** The current (or last successful) connection attempt; null when not connected. */
  private connection: Promise<void> | null = null;
  /** Set after a failed connect, so the next success is logged as a recovery. */
  private unavailable = false;

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async publishOrderPlaced(event: OrderPlaced): Promise<void> {
    await this.send({
      topic: ORDER_PLACED_TOPIC,
      messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
    });
  }

  async publishOrderCancelled(event: OrderCancelled): Promise<void> {
    await this.send({
      topic: ORDER_CANCELLED_TOPIC,
      messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
    });
  }

  /**
   * Republishes a stored event (dead-letter retry): the same event, with the same `eventId`, to
   * the topic it was meant for, keyed by its `aggregateId`. Delivery is at-least-once; consumers
   * deduplicate by `eventId`. The caller validates the topic and the payload ids first.
   */
  async republish(topic: string, payload: Record<string, unknown>): Promise<void> {
    await this.send({
      topic,
      messages: [{ key: String(payload.aggregateId), value: JSON.stringify(payload) }],
    });
  }

  async publishOrderConfirmed(event: OrderConfirmed): Promise<void> {
    await this.send({
      topic: ORDER_CONFIRMED_TOPIC,
      messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
    });
  }

  /** Disconnects if a connection was made (waiting for one in flight); a no-op otherwise. */
  async onApplicationShutdown(): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    try {
      await connection;
    } catch {
      return; // never connected
    }
    this.connection = null;
    await this.producer.disconnect();
  }

  private async send(record: ProducerRecord): Promise<void> {
    await this.connect();
    await this.producer.send(record);
  }

  private connect(): Promise<void> {
    if (this.connection === null) {
      const attempt = this.producer.connect().then(
        () => {
          this.logger.log(
            this.unavailable
              ? 'Kafka is available again: producer connected'
              : 'Kafka producer connected',
          );
          this.unavailable = false;
        },
        (error: unknown) => {
          if (this.connection === attempt) {
            this.connection = null;
          }
          this.unavailable = true;
          this.logger.warn(
            `Kafka is unreachable: producer could not connect (${messageOf(error)}); ` +
              'the event is dead-lettered and the next publish tries again',
          );
          throw error;
        },
      );
      this.connection = attempt;
    }
    return this.connection;
  }
}
