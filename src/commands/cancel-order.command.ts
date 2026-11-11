import { InboundEventRef } from './inbound-event-ref';

/** Options for a cancellation triggered by a consumed event rather than the REST endpoint. */
export interface CancelOrderOptions {
  /** Why the order is cancelled (e.g. the payment failure reason). */
  reason?: string;
  /** The consumed event that triggered the cancellation, recorded atomically as processed. */
  inboundEvent?: InboundEventRef;
}

/**
 * Command to cancel a pending order. Dispatched by OrdersController (REST, no options) or by
 * ReactToPaymentOutcomeService when a payment fails (with the reason and the inbound event).
 */
export class CancelOrderCommand {
  public readonly reason?: string;
  public readonly inboundEvent?: InboundEventRef;

  constructor(
    public readonly orderId: string,
    options?: CancelOrderOptions,
  ) {
    this.reason = options?.reason;
    this.inboundEvent = options?.inboundEvent;
  }
}
