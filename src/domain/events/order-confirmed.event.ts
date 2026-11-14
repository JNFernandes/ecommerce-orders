import { randomUUID } from 'crypto';
import { Order } from '../order.aggregate';

/**
 * Domain event raised once a pending order has been confirmed — by Order.confirm() (REST) or by
 * the second positive outcome (`Order.recordPaymentProcessed()` / `Order.recordStockReserved()`)
 * — and published to Kafka topic `orders.order-confirmed` only after the change is durably saved.
 */
export class OrderConfirmed {
  private constructor(
    /** Unique identifier for this publish attempt. */
    public readonly eventId: string,
    /** ISO 8601 timestamp of when the order was confirmed. */
    public readonly occurredAt: string,
    /** The Order.id this event describes. */
    public readonly aggregateId: string,
    /** Event schema version. */
    public readonly version: number,
    /** The customer whose order was confirmed. */
    public readonly customerId: string,
  ) {}

  static from(order: Order): OrderConfirmed {
    return new OrderConfirmed(
      randomUUID(),
      order.updatedAt.toISOString(),
      order.id,
      1,
      order.customerId,
    );
  }
}
