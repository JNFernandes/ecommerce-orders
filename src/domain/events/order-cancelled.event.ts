import { randomUUID } from 'crypto';
import { Order } from '../order.aggregate';

/**
 * Domain event raised by Order.cancel() once a pending order has been cancelled, and
 * published to Kafka topic `orders.order-cancelled` only after the status change is
 * durably saved.
 */
export class OrderCancelled {
  private constructor(
    /** Unique identifier for this publish attempt. */
    public readonly eventId: string,
    /** ISO 8601 timestamp of when the order was cancelled. */
    public readonly occurredAt: string,
    /** The Order.id this event describes. */
    public readonly aggregateId: string,
    /** Event schema version. */
    public readonly version: number,
    /** The customer whose order was cancelled. */
    public readonly customerId: string,
  ) {}

  static from(order: Order): OrderCancelled {
    return new OrderCancelled(
      randomUUID(),
      order.updatedAt.toISOString(),
      order.id,
      1,
      order.customerId,
    );
  }
}
