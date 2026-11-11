import { ProjectionResult, projectOrderEvent } from '../../../src/read-model/order-view.projector';
import {
  OrderCancelledEvent,
  OrderConfirmedEvent,
  OrderEvent,
  OrderPlacedEvent,
} from '../../../src/read-model/order-event';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';

const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const T0 = new Date('2026-11-11T10:00:00.000Z');
const T1 = new Date('2026-11-11T10:00:01.000Z');
const T2 = new Date('2026-11-11T10:00:02.000Z');

function placed(overrides: Partial<OrderPlacedEvent> = {}): OrderPlacedEvent {
  return {
    type: 'OrderPlaced',
    eventId: '10000000-0000-4000-8000-000000000001',
    orderId: ORDER_ID,
    occurredAt: T0,
    customerId: CUSTOMER_ID,
    items: [
      { productId: 'p-1', quantity: 3, unitPrice: 19.99 },
      { productId: 'p-2', quantity: 1, unitPrice: 0.1 },
    ],
    totalAmount: 60.07,
    ...overrides,
  };
}

function confirmed(overrides: Partial<OrderConfirmedEvent> = {}): OrderConfirmedEvent {
  return {
    type: 'OrderConfirmed',
    eventId: '20000000-0000-4000-8000-000000000002',
    orderId: ORDER_ID,
    occurredAt: T1,
    customerId: CUSTOMER_ID,
    ...overrides,
  };
}

function cancelled(overrides: Partial<OrderCancelledEvent> = {}): OrderCancelledEvent {
  return {
    type: 'OrderCancelled',
    eventId: '30000000-0000-4000-8000-000000000003',
    orderId: ORDER_ID,
    occurredAt: T2,
    customerId: CUSTOMER_ID,
    reason: 'Amount exceeds threshold',
    ...overrides,
  };
}

function changed(result: ProjectionResult): { view: OrderView; warnings: string[] } {
  if (result.kind !== 'changed') {
    throw new Error(`expected a change, got ${result.kind}`);
  }
  return result;
}

/** Folds events in the given order, returning the final view. */
function fold(events: OrderEvent[]): OrderView {
  let view: OrderView | null = null;
  for (const event of events) {
    const result = projectOrderEvent(view, event);
    if (result.kind === 'changed') {
      view = result.view;
    }
  }
  if (!view) {
    throw new Error('no view produced');
  }
  return view;
}

describe('projectOrderEvent — in-order lifecycle', () => {
  it('should create a PENDING view from OrderPlaced with every field set', () => {
    const { view, warnings } = changed(projectOrderEvent(null, placed()));

    expect(view).toEqual({
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      status: OrderViewStatus.PENDING,
      items: [
        { productId: 'p-1', quantity: 3, unitPrice: 19.99, subtotal: 59.97 },
        { productId: 'p-2', quantity: 1, unitPrice: 0.1, subtotal: 0.1 },
      ],
      totalAmount: 60.07,
      placedAt: T0,
      confirmedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      updatedAt: T0,
      appliedEventIds: [placed().eventId],
      statusEventId: null,
    });
    expect(warnings).toEqual([]);
  });

  it('should round each subtotal to 2 decimals', () => {
    const { view } = changed(
      projectOrderEvent(
        null,
        placed({ items: [{ productId: 'p-3', quantity: 3, unitPrice: 0.335 }] }),
      ),
    );

    expect(view.items?.[0].subtotal).toBe(1.01);
  });

  it('should confirm a PENDING view', () => {
    const pending = fold([placed()]);

    const { view, warnings } = changed(projectOrderEvent(pending, confirmed()));

    expect(view).toMatchObject({
      status: OrderViewStatus.CONFIRMED,
      confirmedAt: T1,
      cancelledAt: null,
      statusEventId: confirmed().eventId,
      updatedAt: T1,
      placedAt: T0,
      totalAmount: 60.07,
    });
    expect(view.appliedEventIds).toEqual([placed().eventId, confirmed().eventId]);
    expect(warnings).toEqual([]);
  });

  it('should cancel a PENDING view and keep the reason', () => {
    const { view } = changed(projectOrderEvent(fold([placed()]), cancelled()));

    expect(view).toMatchObject({
      status: OrderViewStatus.CANCELLED,
      cancelledAt: T2,
      confirmedAt: null,
      cancellationReason: 'Amount exceeds threshold',
      statusEventId: cancelled().eventId,
      updatedAt: T2,
    });
  });

  it('should keep an empty-string cancellation reason', () => {
    const { view } = changed(projectOrderEvent(fold([placed()]), cancelled({ reason: '' })));

    expect(view.cancellationReason).toBe('');
  });

  it('should leave cancellationReason null when the cancellation has no reason', () => {
    const { view } = changed(projectOrderEvent(fold([placed()]), cancelled({ reason: null })));

    expect(view.cancellationReason).toBeNull();
  });

  it('should keep appliedEventIds sorted regardless of arrival order', () => {
    const view = fold([
      placed({ eventId: 'ffffffff-0000-4000-8000-000000000001' }),
      confirmed({ eventId: '00000000-0000-4000-8000-000000000002' }),
    ]);

    expect(view.appliedEventIds).toEqual([
      '00000000-0000-4000-8000-000000000002',
      'ffffffff-0000-4000-8000-000000000001',
    ]);
  });

  it('should not mutate the current view', () => {
    const pending = fold([placed()]);
    const snapshot = structuredClone(pending);

    projectOrderEvent(pending, confirmed());

    expect(pending).toEqual(snapshot);
  });
});

describe('projectOrderEvent — late and out-of-order events', () => {
  it('should create a CONFIRMED view from an early OrderConfirmed, without items yet', () => {
    const { view } = changed(projectOrderEvent(null, confirmed()));

    expect(view).toEqual({
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      status: OrderViewStatus.CONFIRMED,
      items: null,
      totalAmount: null,
      placedAt: null,
      confirmedAt: T1,
      cancelledAt: null,
      cancellationReason: null,
      updatedAt: T1,
      appliedEventIds: [confirmed().eventId],
      statusEventId: confirmed().eventId,
    });
  });

  it('should create a CANCELLED view with the reason from an early OrderCancelled', () => {
    const { view } = changed(projectOrderEvent(null, cancelled()));

    expect(view).toMatchObject({
      status: OrderViewStatus.CANCELLED,
      cancelledAt: T2,
      cancellationReason: 'Amount exceeds threshold',
      items: null,
    });
  });

  it.each([
    ['CONFIRMED', confirmed()],
    ['CANCELLED', cancelled()],
  ])(
    'should complete a %s view with a late OrderPlaced without reverting its status',
    (status, terminal) => {
      const early = fold([terminal]);

      const { view } = changed(projectOrderEvent(early, placed()));

      expect(view.status).toBe(status);
      expect(view.statusEventId).toBe(terminal.eventId);
      expect(view.items).toHaveLength(2);
      expect(view.totalAmount).toBe(60.07);
      expect(view.placedAt).toEqual(T0);
      expect(view.updatedAt).toEqual(terminal.occurredAt);
    },
  );

  it.each([
    ['placed + confirmed', [placed(), confirmed()]],
    ['placed + cancelled', [placed(), cancelled()]],
    ['placed + cancelled without reason', [placed(), cancelled({ reason: null })]],
  ])('should produce the same view for both arrival orders of %s', (_label, events) => {
    expect(fold([...events].reverse())).toEqual(fold(events));
  });

  describe('conflicting terminal events (never produced by the write side)', () => {
    const earlyConfirm = confirmed({ occurredAt: T1 });
    const lateCancel = cancelled({ occurredAt: T2 });

    it.each([
      ['confirm first', [placed(), earlyConfirm, lateCancel]],
      ['cancel first', [placed(), lateCancel, earlyConfirm]],
      ['cancel, placed, confirm', [lateCancel, placed(), earlyConfirm]],
    ])('should keep the terminal event that occurred first (%s)', (_label, events) => {
      const view = fold(events);

      expect(view).toMatchObject({
        status: OrderViewStatus.CONFIRMED,
        confirmedAt: T1,
        cancelledAt: null,
        cancellationReason: null,
        statusEventId: earlyConfirm.eventId,
        updatedAt: T2,
      });
      expect(view.appliedEventIds).toHaveLength(3);
    });

    it('should report a warning naming both events when the later terminal loses', () => {
      const result = changed(projectOrderEvent(fold([placed(), earlyConfirm]), lateCancel));

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(earlyConfirm.eventId);
      expect(result.warnings[0]).toContain(lateCancel.eventId);
    });

    it('should report a warning naming both events when an earlier terminal replaces the status', () => {
      const result = changed(projectOrderEvent(fold([placed(), lateCancel]), earlyConfirm));

      expect(result.view.status).toBe(OrderViewStatus.CONFIRMED);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(earlyConfirm.eventId);
      expect(result.warnings[0]).toContain(lateCancel.eventId);
    });

    it('should break an occurredAt tie with the smaller eventId, in both arrival orders', () => {
      const a = confirmed({ eventId: '0aaaaaaa-0000-4000-8000-000000000000', occurredAt: T1 });
      const b = cancelled({ eventId: '0bbbbbbb-0000-4000-8000-000000000000', occurredAt: T1 });

      const ab = fold([placed(), a, b]);
      const ba = fold([placed(), b, a]);

      expect(ab).toEqual(ba);
      expect(ab.status).toBe(OrderViewStatus.CONFIRMED);
      expect(ab.statusEventId).toBe(a.eventId);
    });
  });
});

describe('projectOrderEvent — duplicates', () => {
  it.each([
    ['OrderPlaced', [placed()], placed()],
    ['OrderConfirmed', [placed(), confirmed()], confirmed()],
    ['OrderCancelled', [placed(), cancelled()], cancelled()],
    [
      'the losing terminal of a conflict',
      [placed(), confirmed({ occurredAt: T1 }), cancelled({ occurredAt: T2 })],
      cancelled({ occurredAt: T2 }),
    ],
  ])('should return unchanged when %s is applied again', (_label, history, again) => {
    expect(projectOrderEvent(fold(history), again)).toEqual({ kind: 'unchanged' });
  });

  it('should produce the same view when a whole history is folded twice', () => {
    const history = [placed(), confirmed()];

    expect(fold([...history, ...history])).toEqual(fold(history));
  });
});
