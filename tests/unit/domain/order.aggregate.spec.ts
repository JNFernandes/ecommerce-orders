import { Order } from '../../../src/domain/order.aggregate';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { OrderPlaced } from '../../../src/domain/events/order-placed.event';
import { OrderCancelled } from '../../../src/domain/events/order-cancelled.event';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('Order.place()', () => {
  // UT-01
  it('should create order with PENDING status when valid items are provided', () => {
    const order = Order.place(CUSTOMER_ID, [
      { productId: 'prod-001', quantity: 2, unitPrice: 29.99 },
    ]);

    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.id).toBeDefined();
    expect(order.customerId).toBe(CUSTOMER_ID);
  });

  // UT-02
  it('should calculate totalAmount correctly when multiple items are provided', () => {
    const order = Order.place(CUSTOMER_ID, [
      { productId: 'prod-001', quantity: 2, unitPrice: 29.99 },
      { productId: 'prod-002', quantity: 1, unitPrice: 10 },
    ]);

    expect(order.totalAmount).toBeCloseTo(69.98, 2);
  });

  // UT-03
  it('should raise OrderPlaced domain event when order is placed', () => {
    const order = Order.place(CUSTOMER_ID, [
      { productId: 'prod-001', quantity: 2, unitPrice: 29.99 },
    ]);

    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderPlaced);
    const event = events[0] as OrderPlaced;
    expect(event.aggregateId).toBe(order.id);
    expect(event.totalAmount).toBe(order.totalAmount);
  });

  // UT-11
  it('should consolidate duplicate productId items into one line item with summed quantity', () => {
    const order = Order.place(CUSTOMER_ID, [
      { productId: 'prod-001', quantity: 2, unitPrice: 29.99 },
      { productId: 'prod-001', quantity: 3, unitPrice: 29.99 },
    ]);

    expect(order.items).toHaveLength(1);
    expect(order.items[0].productId).toBe('prod-001');
    expect(order.items[0].quantity).toBe(5);
  });

  // UT-04
  it('should throw when items array is empty', () => {
    expect(() => Order.place(CUSTOMER_ID, [])).toThrow('items must not be empty');
  });

  // UT-05
  it('should throw when quantity is not greater than 0', () => {
    expect(() =>
      Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 0, unitPrice: 29.99 }]),
    ).toThrow('quantity must be greater than 0');
  });

  // UT-06
  it('should throw when unitPrice is not greater than 0', () => {
    expect(() =>
      Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 0 }]),
    ).toThrow('unitPrice must be greater than 0');
  });

  it('should not lose precision when computing totals for values prone to floating-point drift', () => {
    const order = Order.place(CUSTOMER_ID, [
      { productId: 'prod-001', quantity: 3, unitPrice: 0.1 },
    ]);

    expect(order.totalAmount).toBe(0.3);
  });
});

describe('Order.cancel()', () => {
  function placeOrder(): Order {
    return Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }]);
  }

  it('should transition a PENDING order to CANCELLED', () => {
    const order = placeOrder();

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('should raise an OrderCancelled domain event', () => {
    const order = placeOrder();
    order.pullDomainEvents(); // drain the OrderPlaced event raised by place()

    order.cancel();

    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OrderCancelled);
    const event = events[0] as OrderCancelled;
    expect(event.aggregateId).toBe(order.id);
    expect(event.customerId).toBe(CUSTOMER_ID);
  });

  it('should throw OrderCancellationError when the order is already CANCELLED', () => {
    const order = placeOrder();
    order.cancel();

    expect(() => order.cancel()).toThrow(/only a PENDING order can be cancelled/);
  });
});
