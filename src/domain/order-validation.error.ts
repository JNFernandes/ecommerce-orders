/** Raised by Order.place() when the submitted items violate a domain invariant. */
export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}
