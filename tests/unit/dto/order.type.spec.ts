import { OrderType } from '../../../src/dto/graphql/order.type';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';

const EXPOSED_KEYS = [
  'cancellationReason',
  'cancelledAt',
  'confirmedAt',
  'customerId',
  'items',
  'orderId',
  'placedAt',
  'status',
  'totalAmount',
];

function view(overrides: Partial<OrderView> = {}): OrderView {
  return {
    orderId: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    status: OrderViewStatus.CONFIRMED,
    items: [{ productId: 'p-1', quantity: 2, unitPrice: 19.99, subtotal: 39.98 }],
    totalAmount: 39.98,
    placedAt: new Date('2026-11-11T10:00:00.000Z'),
    confirmedAt: new Date('2026-11-11T10:00:01.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: new Date('2026-11-11T10:00:01.000Z'),
    appliedEventIds: ['10000000-0000-4000-8000-000000000001'],
    statusEventId: '20000000-0000-4000-8000-000000000002',
    ...overrides,
  };
}

describe('OrderType.fromView', () => {
  it('should copy every exposed field of a complete view', () => {
    const source = view();

    const order = OrderType.fromView(source);

    expect({ ...order, items: order.items?.map((item) => ({ ...item })) }).toEqual({
      orderId: source.orderId,
      customerId: source.customerId,
      status: OrderViewStatus.CONFIRMED,
      items: [{ productId: 'p-1', quantity: 2, unitPrice: 19.99, subtotal: 39.98 }],
      totalAmount: 39.98,
      placedAt: source.placedAt,
      confirmedAt: source.confirmedAt,
      cancelledAt: null,
      cancellationReason: null,
    });
  });

  it('should keep nulls for a view created before OrderPlaced was projected', () => {
    const order = OrderType.fromView(view({ items: null, totalAmount: null, placedAt: null }));

    expect(order.items).toBeNull();
    expect(order.totalAmount).toBeNull();
    expect(order.placedAt).toBeNull();
  });

  it('should expose only the documented fields — never the read-model bookkeeping', () => {
    const order = OrderType.fromView(view());

    expect(Object.keys(order).sort()).toEqual(EXPOSED_KEYS);
  });
});
