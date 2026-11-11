/**
 * Identifies the consumed Kafka event that triggered a command, so the command handler can
 * record it as processed in the same transaction as the state change.
 */
export interface InboundEventRef {
  /** The consumed event's `eventId` (dedupe key). */
  eventId: string;
  /** Topic the event was consumed from. */
  topic: string;
  /** The order the event refers to — taken from the payload's `orderId` field. */
  orderId: string;
  /**
   * The payment id — taken from the payload's `aggregateId`. Stored for audit and logs only;
   * it is NEVER an order id and must never be used to look one up.
   */
  paymentId: string;
}
