import { InboundEventRef } from './inbound-event-ref';

/** Command dispatched by IdentityEventsConsumer for every valid `identity.user-registered` event. */
export class CreateCustomerCommand {
  constructor(
    /** The event's `customerId` (never its `aggregateId`, the user id). */
    public readonly customerId: string,
    /** Display name, or null when the event has none. */
    public readonly name: string | null,
    /** Email address, as received. */
    public readonly email: string,
    /** The consumed event (its `customerId` is set; `orderId` is not). */
    public readonly ref: InboundEventRef,
  ) {}
}
