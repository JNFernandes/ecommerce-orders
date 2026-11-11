/** Fields common to every order event, as consumed by the projection. */
interface OrderEventBase {
  /** Unique id of the event instance (dedupe key). */
  eventId: string;
  /** The order the event describes (the event's `aggregateId`). */
  orderId: string;
  /** When the event happened on the write side. */
  occurredAt: Date;
  /** The customer who owns the order. */
  customerId: string;
}

/** An order was placed (topic `orders.order-placed`). */
export interface OrderPlacedEvent extends OrderEventBase {
  type: 'OrderPlaced';
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  totalAmount: number;
}

/** An order was confirmed (topic `orders.order-confirmed`). */
export interface OrderConfirmedEvent extends OrderEventBase {
  type: 'OrderConfirmed';
}

/** An order was cancelled (topic `orders.order-cancelled`). */
export interface OrderCancelledEvent extends OrderEventBase {
  type: 'OrderCancelled';
  /** Why it was cancelled; null when the event carried no reason. */
  reason: string | null;
}

/** A validated order event, ready to be projected into the read model. */
export type OrderEvent = OrderPlacedEvent | OrderConfirmedEvent | OrderCancelledEvent;
