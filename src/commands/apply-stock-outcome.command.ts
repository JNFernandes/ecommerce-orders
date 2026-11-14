import { StockOutcome } from '../domain/stock-outcome.enum';
import { InboundEventRef } from './inbound-event-ref';

/** Command dispatched by InventoryEventsConsumer for every valid consumed stock event. */
export class ApplyStockOutcomeCommand {
  constructor(
    /** Whether the stock was reserved or rejected (never PENDING). */
    public readonly outcome: StockOutcome.RESERVED | StockOutcome.REJECTED,
    /** The consumed event (its `orderId` identifies the order; `reservationId` is audit only). */
    public readonly inboundEvent: InboundEventRef,
    /** Rejection reason as announced by Inventory (REJECTED only); may be absent. */
    public readonly reason?: string,
  ) {}
}
