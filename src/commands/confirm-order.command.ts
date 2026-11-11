import { InboundEventRef } from './inbound-event-ref';

/**
 * Command to confirm a pending order. Dispatched by OrdersController (REST) or by
 * ReactToPaymentOutcomeService when a payment succeeds — in the latter case `inboundEvent`
 * identifies the consumed event, which is recorded as processed atomically with the change.
 */
export class ConfirmOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly inboundEvent?: InboundEventRef,
  ) {}
}
