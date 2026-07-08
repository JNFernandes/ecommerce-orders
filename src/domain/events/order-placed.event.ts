import { randomUUID } from 'crypto';
import { Order } from '../order.aggregate';

/** A single item within the OrderPlaced event payload. */
export class OrderPlacedItem {
  constructor(
    /** Reference to the product this line item is for. */
    public readonly productId: string,
    /** Consolidated quantity for this product. */
    public readonly quantity: number,
    /** Unit price used to compute this line's subtotal. */
    public readonly unitPrice: number,
  ) {}
}

/**
 * Domain event raised by Order.place() once an order has been created, and published
 * to Kafka topic `orders.order-placed` only after the order is durably saved.
 */
export class OrderPlaced {
  private constructor(
    /** Unique identifier for this publish attempt. */
    public readonly eventId: string,
    /** ISO 8601 timestamp of when the order was placed. */
    public readonly occurredAt: string,
    /** The Order.id this event describes. */
    public readonly aggregateId: string,
    /** Event schema version. */
    public readonly version: number,
    /** The customer who placed the order. */
    public readonly customerId: string,
    /** Consolidated line items. */
    public readonly items: OrderPlacedItem[],
    /** Order total, sum of all item subtotals. */
    public readonly totalAmount: number,
  ) {}

  static from(order: Order): OrderPlaced {
    return new OrderPlaced(
      randomUUID(),
      order.createdAt.toISOString(),
      order.id,
      1,
      order.customerId,
      order.items.map((item) => new OrderPlacedItem(item.productId, item.quantity, item.unitPrice)),
      order.totalAmount,
    );
  }
}
