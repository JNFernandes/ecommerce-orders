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
 * | event          | effect                                                               |
 * |----------------|----------------------------------------------------------------------|
 * | OrderPlaced    | create the view as PENDING with customer, items (+subtotal), total,   |
 * |                | placedAt                                                              |
 * | OrderConfirmed | PENDING → CONFIRMED, confirmedAt                                      |
 * | OrderCancelled | PENDING → CANCELLED, cancelledAt, cancellationReason                  |
 *
 * A second terminal event never changes a terminal status; it is recorded and reported as a
 * warning. Every applied event is added to `appliedEventIds` (kept sorted) and `updatedAt`
 * becomes the latest `occurredAt` — never the projection time — so replays are deterministic.
 * See docs/read-model.md.
 */
export function projectOrderEvent(current: OrderView | null, event: OrderEvent): ProjectionResult {
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

function applyTerminal(view: OrderView, event: TerminalEvent, warnings: string[]): OrderView {
  if (view.statusEventId !== null) {
    warnings.push(
      `order ${view.orderId}: ignoring ${event.type} ${event.eventId}; ` +
        `status already decided by ${view.statusEventId} (${view.status})`,
    );
    return view;
  }
  return withTerminal(view, event);
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
