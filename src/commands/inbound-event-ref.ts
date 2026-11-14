/**
 * Identifies the consumed Kafka event that triggered a command, so the command handler can
 * record it as processed in the same transaction as the state change. Exactly one of
 * `paymentId` / `reservationId` is set, depending on the event's source.
 */
export interface InboundEventRef {
  /** The consumed event's `eventId` (dedupe key). */
  eventId: string;
  /** Topic the event was consumed from. */
  topic: string;
  /** The order the event refers to — taken from the payload's `orderId` field. */
  orderId: string;
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
}

/** One-line description of an inbound event for log messages. */
export function describeInboundEvent(ref: InboundEventRef): string {
  const source =
    ref.reservationId !== undefined
      ? `reservationId=${ref.reservationId}`
      : `paymentId=${ref.paymentId ?? 'unknown'}`;
  return `orderId=${ref.orderId} ${source} eventId=${ref.eventId} topic=${ref.topic}`;
}
