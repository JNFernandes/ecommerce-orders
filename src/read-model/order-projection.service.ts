import { Injectable, Logger } from '@nestjs/common';
import { OrderEvent } from './order-event';
import { projectOrderEvent } from './order-view.projector';
import { OrderViewRepository } from './order-view.repository';

/** What projecting an event did. */
export type ProjectionOutcome = 'applied' | 'duplicate';

/**
 * Applies one order event to the read model: load the view, run the projection rules
 * (projectOrderEvent), and save the result with optimistic concurrency. Orchestration only —
 * the rules live in the projector. Writes only to MongoDB, never to the write model.
 */
@Injectable()
export class OrderProjectionService {
  private readonly logger = new Logger(OrderProjectionService.name);

  constructor(private readonly repository: OrderViewRepository) {}

  /**
   * @throws OrderViewConcurrencyError on a concurrent write (retryable).
   * @throws ReadModelUnavailableError when MongoDB is unreachable.
   */
  async project(event: OrderEvent): Promise<ProjectionOutcome> {
    const stored = await this.repository.findById(event.orderId);
    const result = projectOrderEvent(stored?.view ?? null, event);

    if (result.kind === 'unchanged') {
      this.logger.debug(`order ${event.orderId}: event ${event.eventId} already applied, skipping`);
      return 'duplicate';
    }
    for (const warning of result.warnings) {
      this.logger.warn(warning);
    }

    if (stored) {
      await this.repository.replace(result.view, stored.revision);
    } else {
      await this.repository.insert(result.view);
    }
    return 'applied';
  }
}
