import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrderDeadLetterEntity } from '../infra/database/entities/order-dead-letter.entity';
import { OrderPlaced } from '../domain/events/order-placed.event';

/** Persists OrderPlaced events that failed to publish to Kafka, so they can be retried later. */
@Injectable()
export class OrderDeadLetterRepository {
  constructor(
    @InjectRepository(OrderDeadLetterEntity)
    private readonly repository: Repository<OrderDeadLetterEntity>,
  ) {}

  async recordFailure(topic: string, event: OrderPlaced, error: Error): Promise<void> {
    const entity = this.repository.create({
      id: randomUUID(),
      eventId: event.eventId,
      topic,
      payload: { ...event },
      error: error.message,
      retryCount: 0,
    });
    await this.repository.save(entity);
  }
}
