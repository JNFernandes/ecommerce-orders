import { Inject, Injectable } from '@nestjs/common';
import { Producer } from 'kafkajs';
import { KAFKA_PRODUCER } from './kafka.constants';
import { OrderPlaced } from '../../domain/events/order-placed.event';

export const ORDER_PLACED_TOPIC = 'orders.order-placed';

/** Publishes OrderPlaced domain events to Kafka. This service only ever produces this topic. */
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
}
