import { PaymentOutcome } from '../domain/payment-outcome.enum';
import { InboundEventRef } from './inbound-event-ref';

/** Command dispatched by PaymentEventsConsumer for every valid consumed payment event. */
export class ReactToPaymentOutcomeCommand {
  constructor(
    /** Whether the payment succeeded or failed. */
    public readonly outcome: PaymentOutcome,
    /** The consumed event (its `orderId` identifies the order). */
    public readonly inboundEvent: InboundEventRef,
    /** Payment failure reason (FAILED only). */
    public readonly reason?: string,
  ) {}
}
