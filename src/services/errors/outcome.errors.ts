/**
 * The consumed event's `eventId` is already in `processed_events`. Not an error for the
 * caller: the message is acknowledged as already processed.
 */
export class EventAlreadyProcessedError extends Error {
  constructor(public readonly eventId: string) {
    super(`event ${eventId} has already been processed`);
    this.name = 'EventAlreadyProcessedError';
  }
}

/**
 * No order matches the `orderId` of a consumed payment or stock event. Retryable: retried
 * with backoff, then dead-lettered (and later replayed by the dead-letter retry worker).
 */
export class OrderNotFoundForOutcomeError extends Error {
  constructor(
    /** The `orderId` the event referenced. */
    public readonly orderId: string,
    /** Topic the event was consumed from. */
    public readonly topic: string,
    /** The event's source id (payment id or reservation id), for the log; never an order id. */
    public readonly sourceId?: string,
  ) {
    super(`no order ${orderId} found for ${topic} event (source ${sourceId ?? 'unknown'})`);
    this.name = 'OrderNotFoundForOutcomeError';
  }
}
