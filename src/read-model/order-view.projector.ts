import {
  OrderCancelledEvent,
  OrderConfirmedEvent,
  OrderEvent,
  OrderPlacedEvent,
} from './order-event';
import { OrderItemView, OrderView } from './order-view';
import { OrderViewStatus } from './order-view-status.enum';

/** Result of projecting one event onto a view. */
export type ProjectionResult =
  { kind: 'unchanged' } | { kind: 'changed'; view: OrderView; warnings: string[] };

type TerminalEvent = OrderConfirmedEvent | OrderCancelledEvent;

/**
 * Read-side projection rules: applies one order event to the current view (or `null` when the
 * order has no view yet) and returns the new view. Pure — no I/O, never mutates `current`.
 *
 * | event          | effect                                                                |
 * |----------------|-----------------------------------------------------------------------|
 * | OrderPlaced    | fill customer, items (+subtotal), total, placedAt; a new view starts  |
 * |                | as PENDING, a CONFIRMED/CANCELLED view keeps its status               |
 * | OrderConfirmed | → CONFIRMED, confirmedAt (creating the view if it arrives first)      |
 * | OrderCancelled | → CANCELLED, cancelledAt, cancellationReason (likewise)               |
 *
 * - An event whose id is already in `appliedEventIds` is a no-op (`unchanged`).
 * - Conflicting terminal events resolve to the one that occurred first, with a warning.
 * - Every applied event is added to `appliedEventIds` (kept sorted) and `updatedAt` becomes the
 *   latest `occurredAt` — never the projection time — so any arrival order and any replay
 *   produce the same view. See docs/read-model.md.
 */
export function projectOrderEvent(current: OrderView | null, event: OrderEvent): ProjectionResult {
  // Idempotence: an event already applied to this view (redelivery, replay) changes nothing.
  if (current?.appliedEventIds.includes(event.eventId)) {
    return { kind: 'unchanged' };
  }

  const warnings: string[] = [];
  const base = current ?? emptyView(event);

  let next: OrderView;
  switch (event.type) {
    case 'OrderPlaced':
      next = applyPlaced(base, event);
      break;
    case 'OrderConfirmed':
    case 'OrderCancelled':
      next = applyTerminal(base, event, warnings);
      break;
  }

  return { kind: 'changed', view: recordApplied(next, event), warnings };
}

function emptyView(event: OrderEvent): OrderView {
  return {
    orderId: event.orderId,
    customerId: event.customerId,
    status: OrderViewStatus.PENDING,
    items: null,
    totalAmount: null,
    placedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: event.occurredAt,
    appliedEventIds: [],
    statusEventId: null,
  };
}

function applyPlaced(view: OrderView, event: OrderPlacedEvent): OrderView {
  return {
    ...view,
    customerId: event.customerId,
    items: event.items.map(toItemView),
    totalAmount: event.totalAmount,
    placedAt: event.occurredAt,
  };
}

/**
 * Sets the terminal status, or — when one is already set (never produced by the write side,
 * which allows one transition from PENDING) — keeps whichever terminal event occurred first
 * (earlier `occurredAt`, then smaller `eventId`), so the result does not depend on arrival order.
 */
function applyTerminal(view: OrderView, event: TerminalEvent, warnings: string[]): OrderView {
  if (view.statusEventId === null) {
    return withTerminal(view, event);
  }

  const winnerAt = view.confirmedAt ?? view.cancelledAt;
  const challengerIsEarlier =
    winnerAt === null ||
    event.occurredAt < winnerAt ||
    (event.occurredAt.getTime() === winnerAt.getTime() && event.eventId < view.statusEventId);

  if (challengerIsEarlier) {
    warnings.push(
      `order ${view.orderId}: conflicting terminal events; ${event.type} ${event.eventId} ` +
        `occurred before ${view.statusEventId} (${view.status}) and now decides the status`,
    );
    return withTerminal(view, event);
  }

  warnings.push(
    `order ${view.orderId}: conflicting terminal events; ignoring ${event.type} ${event.eventId}, ` +
      `status already decided by earlier ${view.statusEventId} (${view.status})`,
  );
  return view;
}

function withTerminal(view: OrderView, event: TerminalEvent): OrderView {
  if (event.type === 'OrderConfirmed') {
    return {
      ...view,
      status: OrderViewStatus.CONFIRMED,
      confirmedAt: event.occurredAt,
      cancelledAt: null,
      cancellationReason: null,
      statusEventId: event.eventId,
    };
  }
  return {
    ...view,
    status: OrderViewStatus.CANCELLED,
    cancelledAt: event.occurredAt,
    cancellationReason: event.reason,
    confirmedAt: null,
    statusEventId: event.eventId,
  };
}

function recordApplied(view: OrderView, event: OrderEvent): OrderView {
  return {
    ...view,
    appliedEventIds: [...view.appliedEventIds, event.eventId].sort(),
    updatedAt: event.occurredAt > view.updatedAt ? event.occurredAt : view.updatedAt,
  };
}

function toItemView(item: OrderPlacedEvent['items'][number]): OrderItemView {
  return {
    productId: item.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    subtotal: Math.round(item.quantity * item.unitPrice * 100) / 100,
  };
}
