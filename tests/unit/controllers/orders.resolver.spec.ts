import 'reflect-metadata';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { OrdersResolver } from '../../../src/controllers/orders.resolver';
import { ListOrdersQuery } from '../../../src/queries/list-orders.query';
import { ListOrdersArgs } from '../../../src/dto/graphql/list-orders.args';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';

const VIEW: OrderView = {
  orderId: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  status: OrderViewStatus.PENDING,
  items: [{ productId: 'p-1', quantity: 1, unitPrice: 5, subtotal: 5 }],
  totalAmount: 5,
  placedAt: new Date('2026-11-11T10:00:00.000Z'),
  confirmedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
  appliedEventIds: ['10000000-0000-4000-8000-000000000001'],
  statusEventId: null,
};

function args(overrides: Partial<ListOrdersArgs> = {}): ListOrdersArgs {
  return Object.assign(new ListOrdersArgs(), { limit: 20, offset: 0, ...overrides });
}

function build(): { resolver: OrdersResolver; execute: jest.Mock } {
  const execute = jest.fn().mockResolvedValue({ views: [VIEW], totalCount: 7, hasNextPage: true });
  const resolver = new OrdersResolver({ execute } as unknown as QueryBus);
  return { resolver, execute };
}

describe('OrdersResolver.orders', () => {
  it('should dispatch exactly one ListOrdersQuery with the page from the arguments', async () => {
    const { resolver, execute } = build();

    await resolver.orders(args({ limit: 5, offset: 10 }));

    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0][0] as ListOrdersQuery;
    expect(query).toBeInstanceOf(ListOrdersQuery);
    expect(query.page).toEqual({ limit: 5, offset: 10 });
    expect(query.filter).toEqual({});
  });

  it('should map the read views to GraphQL orders without read-model bookkeeping', async () => {
    const { resolver } = build();

    const page = await resolver.orders(args());

    expect(page.totalCount).toBe(7);
    expect(page.hasNextPage).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].orderId).toBe(VIEW.orderId);
    expect(page.items[0]).not.toHaveProperty('appliedEventIds');
    expect(page.items[0]).not.toHaveProperty('statusEventId');
    expect(page.items[0]).not.toHaveProperty('updatedAt');
  });

  it('should depend only on the QueryBus — never on the CommandBus', () => {
    const dependencies: unknown[] = Reflect.getMetadata('design:paramtypes', OrdersResolver) ?? [];

    expect(dependencies).toEqual([QueryBus]);
    expect(dependencies).not.toContain(CommandBus);
  });
});
