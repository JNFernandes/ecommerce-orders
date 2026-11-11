import { OrderViewStatus } from './order-view-status.enum';

/** One line of an order, as stored in the read model. */
export interface OrderItemView {
  productId: string;
  quantity: number;
  unitPrice: number;
  /** `quantity × unitPrice`, rounded to 2 decimals. */
  subtotal: number;
}

/**
 * Read-model view of one order (a document in `order_views`). Every field is always present;
 * values not known yet are `null`. Derived entirely from order events — see docs/read-model.md.
 */
export interface OrderView {
  orderId: string;
  customerId: string;
  status: OrderViewStatus;
  /** Null until OrderPlaced has been applied. */
  items: OrderItemView[] | null;
  /** Null until OrderPlaced has been applied. */
  totalAmount: number | null;
  /** OrderPlaced's `occurredAt`; null until it has been applied. */
  placedAt: Date | null;
  /** Set only when status is CONFIRMED. */
  confirmedAt: Date | null;
  /** Set only when status is CANCELLED. */
  cancelledAt: Date | null;
  /** Set only when status is CANCELLED and the cancellation carried a reason (may be ''). */
  cancellationReason: string | null;
  /** Latest `occurredAt` among the applied events (never the projection time). */
  updatedAt: Date;
  /** Event ids already applied to this view, sorted ascending (dedupe set). */
  appliedEventIds: string[];
  /** Id of the terminal event that decided `status`; null while PENDING. */
  statusEventId: string | null;
}

/** A view as stored, with its optimistic-concurrency revision. */
export interface StoredOrderView {
  view: OrderView;
  revision: number;
}
