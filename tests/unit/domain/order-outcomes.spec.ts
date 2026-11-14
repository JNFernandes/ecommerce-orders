import { Order } from '../../../src/domain/order.aggregate';
import { OrderItem } from '../../../src/domain/order-item.value-object';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import { StockOutcome } from '../../../src/domain/stock-outcome.enum';
import { Attention, OutcomeRecord } from '../../../src/domain/outcome-application';
import { OrderConfirmed } from '../../../src/domain/events/order-confirmed.event';
import { OrderCancelled } from '../../../src/domain/events/order-cancelled.event';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';

/** A freshly placed order whose OrderPlaced event has already been drained. */
function placedOrder(): Order {
  const order = Order.place(CUSTOMER_ID, [{ productId: 'sku-1', quantity: 2, unitPrice: 10 }]);
  order.pullDomainEvents();
  return order;
}

/** An order loaded from storage in the given state (raises no events). */
function storedOrder(
  status: OrderStatus,
  paymentOutcome: PaymentOutcome,
  stockOutcome: StockOutcome,
  cancellationReason: string | null = null,
): Order {
  const created = new Date('2026-11-14T10:00:00.000Z');
  return Order.reconstitute(
    ORDER_ID,
    CUSTOMER_ID,
    status,
    [OrderItem.create('sku-1', 2, 10)],
    20,
    created,
    created,
    cancellationReason,
    paymentOutcome,
    stockOutcome,
  );
}

describe('Order outcomes — initial state', () => {
  it('should start a placed order with payment and stock outcomes PENDING', () => {
    const order = placedOrder();

    expect(order.paymentOutcome).toBe(PaymentOutcome.PENDING);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
  });

  it('should keep the stored outcomes when an order is reconstituted', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING);

    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should default both outcomes to PENDING when reconstituted without them', () => {
    const created = new Date('2026-11-14T10:00:00.000Z');
    const order = Order.reconstitute(
      ORDER_ID,
      CUSTOMER_ID,
      OrderStatus.PENDING,
      [OrderItem.create('sku-1', 2, 10)],
      20,
      created,
      created,
    );

    expect(order.paymentOutcome).toBe(PaymentOutcome.PENDING);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
  });
});

describe('Order outcomes — positive outcomes on a PENDING order', () => {
  it('should record a processed payment and stay PENDING when stock is still pending', () => {
    const order = placedOrder();

    const result = order.recordPaymentProcessed();

    expect(result).toEqual({ record: OutcomeRecord.RECORDED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should record a reserved stock and stay PENDING when the payment is still pending', () => {
    const order = placedOrder();

    const result = order.recordStockReserved();

    expect(result).toEqual({ record: OutcomeRecord.RECORDED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.stockOutcome).toBe(StockOutcome.RESERVED);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PENDING);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should refresh updatedAt when a first positive outcome is recorded', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.PENDING);
    const before = order.updatedAt;

    order.recordPaymentProcessed();

    expect(order.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('should confirm and raise OrderConfirmed when stock is reserved after the payment was processed', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING);

    const result = order.recordStockReserved();

    expect(result).toEqual({ record: OutcomeRecord.CONFIRMED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.stockOutcome).toBe(StockOutcome.RESERVED);
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderConfirmed);
    expect((events[0] as OrderConfirmed).aggregateId).toBe(ORDER_ID);
    expect((events[0] as OrderConfirmed).occurredAt).toBe(order.updatedAt.toISOString());
  });

  it('should confirm and raise OrderConfirmed when the payment is processed after stock was reserved', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.RESERVED);

    const result = order.recordPaymentProcessed();

    expect(result).toEqual({ record: OutcomeRecord.CONFIRMED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderConfirmed);
  });

  it('should ignore a second processed payment on a PENDING order as a duplicate', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING);
    const before = order.updatedAt;

    const result = order.recordPaymentProcessed();

    expect(result).toEqual({ record: OutcomeRecord.IGNORED_DUPLICATE, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(order.updatedAt).toBe(before);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should ignore a second reserved stock on a PENDING order as a duplicate', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.RESERVED);

    const result = order.recordStockReserved();

    expect(result).toEqual({ record: OutcomeRecord.IGNORED_DUPLICATE, attention: Attention.NONE });
    expect(order.stockOutcome).toBe(StockOutcome.RESERVED);
    expect(order.pullDomainEvents()).toEqual([]);
  });
});

describe('Order outcomes — negative outcomes on a PENDING order', () => {
  it('should cancel with a "payment failed" reason and raise OrderCancelled when the payment fails', () => {
    const order = placedOrder();

    const result = order.recordPaymentFailed('amount exceeds the threshold');

    expect(result).toEqual({ record: OutcomeRecord.CANCELLED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.paymentOutcome).toBe(PaymentOutcome.FAILED);
    expect(order.cancellationReason).toBe('payment failed: amount exceeds the threshold');
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderCancelled);
    expect((events[0] as OrderCancelled).reason).toBe(
      'payment failed: amount exceeds the threshold',
    );
  });

  it('should cancel with a "stock rejected" reason and raise OrderCancelled when the stock is rejected', () => {
    const order = placedOrder();

    const result = order.recordStockRejected('insufficient stock');

    expect(result).toEqual({ record: OutcomeRecord.CANCELLED, attention: Attention.NONE });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.stockOutcome).toBe(StockOutcome.REJECTED);
    expect(order.cancellationReason).toBe('stock rejected: insufficient stock');
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect((events[0] as OrderCancelled).reason).toBe('stock rejected: insufficient stock');
  });

  it('should cancel when the stock is rejected after the payment was processed', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING);

    const result = order.recordStockRejected('unknown product');

    expect(result.record).toBe(OutcomeRecord.CANCELLED);
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(order.stockOutcome).toBe(StockOutcome.REJECTED);
    expect(order.cancellationReason).toBe('stock rejected: unknown product');
  });

  it('should cancel when the payment fails after the stock was reserved', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.RESERVED);

    const result = order.recordPaymentFailed('card declined');

    expect(result.record).toBe(OutcomeRecord.CANCELLED);
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancellationReason).toBe('payment failed: card declined');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('should use the bare "payment failed" reason when the reason is %s', (_label, reason) => {
    const order = placedOrder();

    order.recordPaymentFailed(reason);

    expect(order.cancellationReason).toBe('payment failed');
    expect((order.pullDomainEvents()[0] as OrderCancelled).reason).toBe('payment failed');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('should use the bare "stock rejected" reason when the reason is %s', (_label, reason) => {
    const order = placedOrder();

    order.recordStockRejected(reason);

    expect(order.cancellationReason).toBe('stock rejected');
  });

  it('should trim the source reason before building the cancellation reason', () => {
    const order = placedOrder();

    order.recordStockRejected('  insufficient stock  ');

    expect(order.cancellationReason).toBe('stock rejected: insufficient stock');
  });

  it('should ignore a failed payment as a conflict when the payment was already processed', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING);
    const before = order.updatedAt;

    const result = order.recordPaymentFailed('late failure');

    expect(result).toEqual({
      record: OutcomeRecord.IGNORED_CONFLICT,
      attention: Attention.CONFLICT,
    });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(order.cancellationReason).toBeNull();
    expect(order.updatedAt).toBe(before);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should ignore a rejected stock as a conflict when the stock was already reserved', () => {
    const order = storedOrder(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.RESERVED);

    const result = order.recordStockRejected('insufficient stock');

    expect(result).toEqual({
      record: OutcomeRecord.IGNORED_CONFLICT,
      attention: Attention.CONFLICT,
    });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.stockOutcome).toBe(StockOutcome.RESERVED);
    expect(order.pullDomainEvents()).toEqual([]);
  });
});

type OutcomeName = 'paymentProcessed' | 'paymentFailed' | 'stockReserved' | 'stockRejected';

/** Applies the named outcome through the matching Order method. */
function apply(order: Order, outcome: OutcomeName): ReturnType<Order['recordPaymentProcessed']> {
  switch (outcome) {
    case 'paymentProcessed':
      return order.recordPaymentProcessed();
    case 'paymentFailed':
      return order.recordPaymentFailed('late reason');
    case 'stockReserved':
      return order.recordStockReserved();
    case 'stockRejected':
      return order.recordStockRejected('late reason');
  }
}

describe('Order outcomes — outcomes for an order that is no longer PENDING', () => {
  const confirmed = (): Order =>
    storedOrder(OrderStatus.CONFIRMED, PaymentOutcome.PROCESSED, StockOutcome.RESERVED);
  const cancelled = (): Order =>
    storedOrder(
      OrderStatus.CANCELLED,
      PaymentOutcome.FAILED,
      StockOutcome.PENDING,
      'payment failed: card declined',
    );

  it.each<[string, () => Order, OutcomeName, OutcomeRecord, Attention]>([
    [
      'CONFIRMED',
      confirmed,
      'paymentProcessed',
      OutcomeRecord.IGNORED_ALREADY_CONFIRMED,
      Attention.NONE,
    ],
    [
      'CONFIRMED',
      confirmed,
      'stockReserved',
      OutcomeRecord.IGNORED_ALREADY_CONFIRMED,
      Attention.NONE,
    ],
    ['CONFIRMED', confirmed, 'paymentFailed', OutcomeRecord.IGNORED_CONFLICT, Attention.CONFLICT],
    ['CONFIRMED', confirmed, 'stockRejected', OutcomeRecord.IGNORED_CONFLICT, Attention.CONFLICT],
    [
      'CANCELLED',
      cancelled,
      'paymentProcessed',
      OutcomeRecord.IGNORED_CONFLICT,
      Attention.REFUND_NEEDED,
    ],
    [
      'CANCELLED',
      cancelled,
      'paymentFailed',
      OutcomeRecord.IGNORED_ALREADY_CANCELLED,
      Attention.NONE,
    ],
    [
      'CANCELLED',
      cancelled,
      'stockReserved',
      OutcomeRecord.IGNORED_ALREADY_CANCELLED,
      Attention.NONE,
    ],
    [
      'CANCELLED',
      cancelled,
      'stockRejected',
      OutcomeRecord.IGNORED_ALREADY_CANCELLED,
      Attention.NONE,
    ],
  ])(
    'should leave a %s order unchanged when %s arrives',
    (_status, build, outcome, expectedRecord, expectedAttention) => {
      const order = build();
      const before = {
        status: order.status,
        paymentOutcome: order.paymentOutcome,
        stockOutcome: order.stockOutcome,
        cancellationReason: order.cancellationReason,
        updatedAt: order.updatedAt,
      };

      const result = apply(order, outcome);

      expect(result).toEqual({ record: expectedRecord, attention: expectedAttention });
      expect({
        status: order.status,
        paymentOutcome: order.paymentOutcome,
        stockOutcome: order.stockOutcome,
        cancellationReason: order.cancellationReason,
        updatedAt: order.updatedAt,
      }).toEqual(before);
      expect(order.pullDomainEvents()).toEqual([]);
    },
  );

  it('should flag a processed payment for an order cancelled by a stock rejection as needing a refund', () => {
    const order = storedOrder(
      OrderStatus.CANCELLED,
      PaymentOutcome.PENDING,
      StockOutcome.REJECTED,
      'stock rejected: insufficient stock',
    );

    const result = order.recordPaymentProcessed();

    expect(result).toEqual({
      record: OutcomeRecord.IGNORED_CONFLICT,
      attention: Attention.REFUND_NEEDED,
    });
    expect(order.paymentOutcome).toBe(PaymentOutcome.PENDING);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('should ignore outcomes for an order cancelled through REST without touching its outcomes', () => {
    const order = storedOrder(OrderStatus.CANCELLED, PaymentOutcome.PENDING, StockOutcome.PENDING);

    expect(order.recordStockReserved().record).toBe(OutcomeRecord.IGNORED_ALREADY_CANCELLED);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
    expect(order.cancellationReason).toBeNull();
  });

  it('should ignore a stock outcome for an order confirmed manually before any outcome arrived', () => {
    const order = storedOrder(OrderStatus.CONFIRMED, PaymentOutcome.PENDING, StockOutcome.PENDING);

    expect(order.recordStockRejected('insufficient stock')).toEqual({
      record: OutcomeRecord.IGNORED_CONFLICT,
      attention: Attention.CONFLICT,
    });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.stockOutcome).toBe(StockOutcome.PENDING);
  });
});

interface Step {
  outcome: OutcomeName;
  record: OutcomeRecord;
  attention: Attention;
  status: OrderStatus;
  payment: PaymentOutcome;
  stock: StockOutcome;
  reason: string | null;
  /** Event raised by this step, if any. */
  event: 'OrderConfirmed' | 'OrderCancelled' | null;
}

const PAY_REASON = 'payment failed: late reason';
const STOCK_REASON = 'stock rejected: late reason';

const { PENDING, CONFIRMED, CANCELLED } = OrderStatus;
const P = PaymentOutcome;
const S = StockOutcome;
const R = OutcomeRecord;
const A = Attention;

/**
 * Every arrival order of one payment outcome and one stock outcome (8 sequences), plus the two
 * same-side contradictions. Each row describes the state after each of the two steps.
 */
const sequences: Array<[string, Step, Step]> = [
  [
    'should confirm when stock is reserved after the payment was processed',
    {
      outcome: 'paymentProcessed',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PROCESSED,
      stock: S.PENDING,
      reason: null,
      event: null,
    },
    {
      outcome: 'stockReserved',
      record: R.CONFIRMED,
      attention: A.NONE,
      status: CONFIRMED,
      payment: P.PROCESSED,
      stock: S.RESERVED,
      reason: null,
      event: 'OrderConfirmed',
    },
  ],
  [
    'should confirm when the payment is processed after stock was reserved',
    {
      outcome: 'stockReserved',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PENDING,
      stock: S.RESERVED,
      reason: null,
      event: null,
    },
    {
      outcome: 'paymentProcessed',
      record: R.CONFIRMED,
      attention: A.NONE,
      status: CONFIRMED,
      payment: P.PROCESSED,
      stock: S.RESERVED,
      reason: null,
      event: 'OrderConfirmed',
    },
  ],
  [
    'should cancel when stock is rejected after the payment was processed',
    {
      outcome: 'paymentProcessed',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PROCESSED,
      stock: S.PENDING,
      reason: null,
      event: null,
    },
    {
      outcome: 'stockRejected',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.PROCESSED,
      stock: S.REJECTED,
      reason: STOCK_REASON,
      event: 'OrderCancelled',
    },
  ],
  [
    'should cancel on stock rejected and flag the later processed payment for a refund',
    {
      outcome: 'stockRejected',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.PENDING,
      stock: S.REJECTED,
      reason: STOCK_REASON,
      event: 'OrderCancelled',
    },
    {
      outcome: 'paymentProcessed',
      record: R.IGNORED_CONFLICT,
      attention: A.REFUND_NEEDED,
      status: CANCELLED,
      payment: P.PENDING,
      stock: S.REJECTED,
      reason: STOCK_REASON,
      event: null,
    },
  ],
  [
    'should cancel on payment failed and ignore the later reserved stock',
    {
      outcome: 'paymentFailed',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.FAILED,
      stock: S.PENDING,
      reason: PAY_REASON,
      event: 'OrderCancelled',
    },
    {
      outcome: 'stockReserved',
      record: R.IGNORED_ALREADY_CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.FAILED,
      stock: S.PENDING,
      reason: PAY_REASON,
      event: null,
    },
  ],
  [
    'should cancel when the payment fails after stock was reserved',
    {
      outcome: 'stockReserved',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PENDING,
      stock: S.RESERVED,
      reason: null,
      event: null,
    },
    {
      outcome: 'paymentFailed',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.FAILED,
      stock: S.RESERVED,
      reason: PAY_REASON,
      event: 'OrderCancelled',
    },
  ],
  [
    'should keep the payment reason when stock is rejected after the payment failed (first negative wins)',
    {
      outcome: 'paymentFailed',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.FAILED,
      stock: S.PENDING,
      reason: PAY_REASON,
      event: 'OrderCancelled',
    },
    {
      outcome: 'stockRejected',
      record: R.IGNORED_ALREADY_CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.FAILED,
      stock: S.PENDING,
      reason: PAY_REASON,
      event: null,
    },
  ],
  [
    'should keep the stock reason when the payment fails after stock was rejected (first negative wins)',
    {
      outcome: 'stockRejected',
      record: R.CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.PENDING,
      stock: S.REJECTED,
      reason: STOCK_REASON,
      event: 'OrderCancelled',
    },
    {
      outcome: 'paymentFailed',
      record: R.IGNORED_ALREADY_CANCELLED,
      attention: A.NONE,
      status: CANCELLED,
      payment: P.PENDING,
      stock: S.REJECTED,
      reason: STOCK_REASON,
      event: null,
    },
  ],
  [
    'should keep the first payment outcome when a failure follows a processed payment',
    {
      outcome: 'paymentProcessed',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PROCESSED,
      stock: S.PENDING,
      reason: null,
      event: null,
    },
    {
      outcome: 'paymentFailed',
      record: R.IGNORED_CONFLICT,
      attention: A.CONFLICT,
      status: PENDING,
      payment: P.PROCESSED,
      stock: S.PENDING,
      reason: null,
      event: null,
    },
  ],
  [
    'should keep the first stock outcome when a rejection follows a reserved stock',
    {
      outcome: 'stockReserved',
      record: R.RECORDED,
      attention: A.NONE,
      status: PENDING,
      payment: P.PENDING,
      stock: S.RESERVED,
      reason: null,
      event: null,
    },
    {
      outcome: 'stockRejected',
      record: R.IGNORED_CONFLICT,
      attention: A.CONFLICT,
      status: PENDING,
      payment: P.PENDING,
      stock: S.RESERVED,
      reason: null,
      event: null,
    },
  ],
];

describe('Order outcomes — every arrival order', () => {
  it.each(sequences)('%s', (_name, first, second) => {
    const order = placedOrder();

    for (const step of [first, second]) {
      const result = apply(order, step.outcome);

      expect(result).toEqual({ record: step.record, attention: step.attention });
      expect(order.status).toBe(step.status);
      expect(order.paymentOutcome).toBe(step.payment);
      expect(order.stockOutcome).toBe(step.stock);
      expect(order.cancellationReason).toBe(step.reason);

      const events = order.pullDomainEvents();
      if (step.event === null) {
        expect(events).toEqual([]);
      } else {
        expect(events).toHaveLength(1);
        expect(events[0]).toBeInstanceOf(
          step.event === 'OrderConfirmed' ? OrderConfirmed : OrderCancelled,
        );
      }
    }
  });

  it('should confirm exactly once even when both positive outcomes are repeated', () => {
    const order = placedOrder();
    const raised = [
      order.recordPaymentProcessed(),
      order.recordStockReserved(),
      order.recordPaymentProcessed(),
      order.recordStockReserved(),
    ].map((result) => result.record);

    expect(raised).toEqual([
      R.RECORDED,
      R.CONFIRMED,
      R.IGNORED_ALREADY_CONFIRMED,
      R.IGNORED_ALREADY_CONFIRMED,
    ]);
    expect(order.pullDomainEvents()).toHaveLength(1);
  });
});
