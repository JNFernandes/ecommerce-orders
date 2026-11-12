import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrderDeadLetterEntity } from '../infra/database/entities/order-dead-letter.entity';
import { RetryUpdate } from '../infra/dead-letter/retry-policy';
import { processNextDue } from './claim-next-due';

interface DomainEventPayload {
  eventId: string;
}

/** Persists domain events that failed to publish to Kafka, and claims them for the retry worker. */
@Injectable()
export class OrderDeadLetterRepository {
  constructor(
    @InjectRepository(OrderDeadLetterEntity)
    private readonly repository: Repository<OrderDeadLetterEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /** Stores an event that failed to publish; it is due for retry immediately. */
  async recordFailure(topic: string, event: DomainEventPayload, error: Error): Promise<void> {
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

  /**
   * Claims the oldest due row with `FOR UPDATE SKIP LOCKED`, runs `handler` while holding the
   * lock and writes its update in the same transaction. A throwing handler rolls back.
   *
   * @returns `false` when nothing is due.
   */
  processNextDue(handler: (row: OrderDeadLetterEntity) => Promise<RetryUpdate>): Promise<boolean> {
    return processNextDue(this.dataSource, OrderDeadLetterEntity, handler);
  }
}
