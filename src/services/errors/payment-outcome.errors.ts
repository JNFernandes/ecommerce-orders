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
 * No order matches the payment event's `orderId`. Retryable: retried with backoff, then
 * dead-lettered.
 */
export class OrderNotFoundForPaymentError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly paymentId: string,
  ) {
    super(`no order ${orderId} found for payment ${paymentId}`);
    this.name = 'OrderNotFoundForPaymentError';
  }
}
