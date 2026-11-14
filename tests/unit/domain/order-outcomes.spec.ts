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
