import { Inject, Injectable } from '@nestjs/common';
import { Producer } from 'kafkajs';
import { KAFKA_PRODUCER } from './kafka.constants';
import { OrderPlaced } from '../../domain/events/order-placed.event';
import { OrderCancelled } from '../../domain/events/order-cancelled.event';
import { OrderConfirmed } from '../../domain/events/order-confirmed.event';

export const ORDER_PLACED_TOPIC = 'orders.order-placed';
export const ORDER_CANCELLED_TOPIC = 'orders.order-cancelled';
export const ORDER_CONFIRMED_TOPIC = 'orders.order-confirmed';

/**
 * Publishes Order domain events to Kafka. These `orders.*` topics are produced only by this
 * service (it also consumes payment events — see PaymentEventsConsumer).
 */
@Injectable()
export class OrderEventsProducer {
  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async publishOrderPlaced(event: OrderPlaced): Promise<void> {
    await this.producer.send({
      topic: ORDER_PLACED_TOPIC,
      messages: [
        {
          key: event.aggregateId,
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async publishOrderCancelled(event: OrderCancelled): Promise<void> {
    await this.producer.send({
      topic: ORDER_CANCELLED_TOPIC,
      messages: [
        {
          key: event.aggregateId,
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async publishOrderConfirmed(event: OrderConfirmed): Promise<void> {
    await this.producer.send({
      topic: ORDER_CONFIRMED_TOPIC,
      messages: [
        {
          key: event.aggregateId,
          value: JSON.stringify(event),
        },
      ],
    });
  }
}
