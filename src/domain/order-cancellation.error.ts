/** Raised by Order.cancel() when the order is not currently PENDING. */
export class OrderCancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderCancellationError';
  }
}
