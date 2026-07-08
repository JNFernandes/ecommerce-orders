/** Raised by Order.confirm() when the order is not currently PENDING. */
export class OrderConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderConfirmationError';
  }
}
