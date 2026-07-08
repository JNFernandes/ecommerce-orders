/**
 * OrderItem is a value object representing a single consolidated line within an Order.
 * `quantity` and `unitPrice` are assumed to have already passed positivity validation
 * by the time this is constructed (see Order.place()).
 */
export class OrderItem {
  private constructor(
    public readonly productId: string,
    public readonly quantity: number,
    public readonly unitPrice: number,
  ) {}

  static create(productId: string, quantity: number, unitPrice: number): OrderItem {
    return new OrderItem(productId, quantity, unitPrice);
  }

  /** quantity × unitPrice, rounded to 2 decimal places to avoid floating-point drift. */
  get subtotal(): number {
    return Math.round(this.quantity * this.unitPrice * 100) / 100;
  }
}
