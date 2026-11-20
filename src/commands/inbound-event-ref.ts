/**
 * Identifies the consumed Kafka event that triggered a command, so the command handler can
 * record it as processed in the same transaction as the state change. Exactly one of
 * `paymentId` / `reservationId` / `customerId` is set, depending on the event's source; `orderId`
 * is set for payment and stock events, `customerId` for identity events.
 */
export interface InboundEventRef {
  /** The consumed event's `eventId` (dedupe key). */
  eventId: string;
  /** Topic the event was consumed from. */
  topic: string;
  /**
   * The order the event refers to — taken from the payload's `orderId` field. Set for payment
   * and stock events; absent for identity events.
   */
  orderId?: string;
  /**
   * For payment events: the payment id, taken from the payload's `aggregateId`. Stored for
   * audit and logs only; it is NEVER an order id and must never be used to look one up.
   */
  paymentId?: string;
  /**
   * For stock events: the reservation id, taken from the payload's `aggregateId`. Stored for
   * audit and logs only; it is NEVER an order id and must never be used to look one up.
   */
  reservationId?: string;
  /**
   * For identity events: the customer id, taken from the payload's `customerId` (US-10). The
   * payload's `aggregateId` (the user id) is never carried.
   */
  customerId?: string;
}

/** One-line description of an inbound event for log messages. */
export function describeInboundEvent(ref: InboundEventRef): string {
  const suffix = `eventId=${ref.eventId} topic=${ref.topic}`;
  if (ref.customerId !== undefined) {
    return `customerId=${ref.customerId} ${suffix}`;
  }
  const source =
    ref.reservationId !== undefined
      ? `reservationId=${ref.reservationId}`
      : `paymentId=${ref.paymentId ?? 'unknown'}`;
  return `orderId=${ref.orderId ?? 'unknown'} ${source} ${suffix}`;
}
