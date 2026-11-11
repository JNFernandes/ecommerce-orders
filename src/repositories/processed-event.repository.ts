import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboundEventRef } from '../commands/inbound-event-ref';
import {
  ProcessedEventEntity,
  ProcessedEventOutcome,
} from '../infra/database/entities/processed-event.entity';
import { EventAlreadyProcessedError } from '../services/errors/payment-outcome.errors';
import { isUniqueViolation } from './errors/is-unique-violation';

/** Idempotency store for consumed events, keyed by `eventId`. */
@Injectable()
export class ProcessedEventRepository {
  constructor(
    @InjectRepository(ProcessedEventEntity)
    private readonly repository: Repository<ProcessedEventEntity>,
  ) {}

  /** True if an event with this `eventId` has already been processed. */
  async exists(eventId: string): Promise<boolean> {
    return this.repository.exists({ where: { eventId } });
  }

  /**
   * Records that the event was handled with `outcome` (used for no-op outcomes; state changes
   * are recorded inside OrderRepository.applyInboundStatusChange's transaction).
   *
   * @throws EventAlreadyProcessedError if the `eventId` is already recorded.
   */
  async recordOutcome(ref: InboundEventRef, outcome: ProcessedEventOutcome): Promise<void> {
    try {
      await this.repository.insert({
        eventId: ref.eventId,
        topic: ref.topic,
        orderId: ref.orderId,
        paymentId: ref.paymentId,
        outcome,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EventAlreadyProcessedError(ref.eventId);
      }
      throw error;
    }
  }
}
