import { PaymentOutcome } from '../domain/payment-outcome.enum';
import { InboundEventRef } from './inbound-event-ref';

/** Command dispatched by PaymentEventsConsumer for every valid consumed payment event. */
export class ApplyPaymentOutcomeCommand {
  constructor(
    /** Whether the payment succeeded or failed (never PENDING). */
    public readonly outcome: PaymentOutcome.PROCESSED | PaymentOutcome.FAILED,
    /** The consumed event (its `orderId` identifies the order; `paymentId` is audit only). */
    public readonly inboundEvent: InboundEventRef,
    /** Failure reason as announced by Payments (FAILED only); may be absent. */
    public readonly reason?: string,
  ) {}
}
