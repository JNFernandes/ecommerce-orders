import 'reflect-metadata';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { OrdersResolver } from '../../../src/controllers/orders.resolver';
import { ListOrdersQuery } from '../../../src/queries/list-orders.query';
import { ListOrdersArgs } from '../../../src/dto/graphql/list-orders.args';
import { GetOrderArgs } from '../../../src/dto/graphql/get-order.args';
import { GetOrderQuery } from '../../../src/queries/get-order.query';
import { OrderType } from '../../../src/dto/graphql/order.type';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { ROLES_KEY } from '../../../src/controllers/auth/roles.decorator';
import { Role } from '../../../src/infra/auth/role.enum';
import { AccessTokenClaims } from '../../../src/infra/auth/access-token-claims';
import { ReadScopeForbiddenError } from '../../../src/queries/order-read-scope';

const ADMIN: AccessTokenClaims = { sub: 'admin-1', roles: [Role.ADMIN] };
const CUSTOMER: AccessTokenClaims = {
  sub: 'user-1',
  roles: [Role.CUSTOMER],
  customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
};

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

    await resolver.orders(args({ limit: 5, offset: 10 }), ADMIN);

    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0][0] as ListOrdersQuery;
    expect(query).toBeInstanceOf(ListOrdersQuery);
    expect(query.page).toEqual({ limit: 5, offset: 10 });
    expect(query.filter).toEqual({});
  });

  it('should pass the status and customerId filters into the query', async () => {
    const { resolver, execute } = build();

    await resolver.orders(
      args({ status: OrderViewStatus.CANCELLED, customerId: VIEW.customerId }),
      ADMIN,
    );

    const query = execute.mock.calls[0][0] as ListOrdersQuery;
    expect(query.filter).toEqual({
      status: OrderViewStatus.CANCELLED,
      customerId: VIEW.customerId,
    });
  });

  it('should leave absent filters out of the query (no undefined keys)', async () => {
    const { resolver, execute } = build();

    await resolver.orders(args({ customerId: VIEW.customerId }), ADMIN);

    const query = execute.mock.calls[0][0] as ListOrdersQuery;
    expect(Object.keys(query.filter)).toEqual(['customerId']);
  });

  it('should map the read views to GraphQL orders without read-model bookkeeping', async () => {
    const { resolver } = build();

    const page = await resolver.orders(args(), ADMIN);

    expect(page.totalCount).toBe(7);
    expect(page.hasNextPage).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].orderId).toBe(VIEW.orderId);
    expect(page.items[0]).not.toHaveProperty('appliedEventIds');
    expect(page.items[0]).not.toHaveProperty('statusEventId');
    expect(page.items[0]).not.toHaveProperty('updatedAt');
  });

  it("should send the caller's read scope with the query: own orders for a customer", async () => {
    const { resolver, execute } = build();

    await resolver.orders(args({ customerId: VIEW.customerId }), CUSTOMER);

    const query = execute.mock.calls[0][0] as ListOrdersQuery;
    expect(query.scope).toEqual({ kind: 'CUSTOMER', customerId: CUSTOMER.customerId });
    expect(query.filter).toEqual({ customerId: VIEW.customerId });
  });

  it('should send the ALL scope for an admin', async () => {
    const { resolver, execute } = build();

    await resolver.orders(args(), ADMIN);

    expect((execute.mock.calls[0][0] as ListOrdersQuery).scope).toEqual({ kind: 'ALL' });
  });

  it('should refuse a caller without a read scope and dispatch nothing', async () => {
    const { resolver, execute } = build();

    await expect(resolver.orders(args(), { sub: 'u', roles: [Role.CUSTOMER] })).rejects.toThrow(
      ReadScopeForbiddenError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('should depend only on the QueryBus — never on the CommandBus', () => {
    const dependencies: unknown[] = Reflect.getMetadata('design:paramtypes', OrdersResolver) ?? [];

    expect(dependencies).toEqual([QueryBus]);
    expect(dependencies).not.toContain(CommandBus);
  });
});

describe('OrdersResolver.order', () => {
  function getArgs(orderId: string): GetOrderArgs {
    return Object.assign(new GetOrderArgs(), { orderId });
  }

  it('should dispatch exactly one GetOrderQuery with the requested id', async () => {
    const execute = jest.fn().mockResolvedValue(VIEW);
    const resolver = new OrdersResolver({ execute } as unknown as QueryBus);

    await resolver.order(getArgs(VIEW.orderId), ADMIN);

    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0][0] as GetOrderQuery;
    expect(query).toBeInstanceOf(GetOrderQuery);
    expect(query.orderId).toBe(VIEW.orderId);
    expect(query.scope).toEqual({ kind: 'ALL' });
  });

  it('should map the found view to a GraphQL order without read-model bookkeeping', async () => {
    const resolver = new OrdersResolver({
      execute: jest.fn().mockResolvedValue(VIEW),
    } as unknown as QueryBus);

    const order = await resolver.order(getArgs(VIEW.orderId), ADMIN);

    expect(order?.orderId).toBe(VIEW.orderId);
    expect(order?.totalAmount).toBe(5);
    expect(order).not.toHaveProperty('appliedEventIds');
    expect(order).not.toHaveProperty('updatedAt');
  });

  it("should send a customer's scope with the by-id query", async () => {
    const execute = jest.fn().mockResolvedValue(null);
    const resolver = new OrdersResolver({ execute } as unknown as QueryBus);

    await resolver.order(getArgs(VIEW.orderId), CUSTOMER);

    expect((execute.mock.calls[0][0] as GetOrderQuery).scope).toEqual({
      kind: 'CUSTOMER',
      customerId: CUSTOMER.customerId,
    });
  });

  it('should refuse a by-id read without a read scope and dispatch nothing', async () => {
    const execute = jest.fn();
    const resolver = new OrdersResolver({ execute } as unknown as QueryBus);

    await expect(resolver.order(getArgs(VIEW.orderId), { sub: 'u', roles: [] })).rejects.toThrow(
      ReadScopeForbiddenError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('should return null, without mapping, when the order is not found', async () => {
    const fromView = jest.spyOn(OrderType, 'fromView');
    const resolver = new OrdersResolver({
      execute: jest.fn().mockResolvedValue(null),
    } as unknown as QueryBus);

    const order = await resolver.order(getArgs(VIEW.orderId), ADMIN);

    expect(order).toBeNull();
    expect(fromView).not.toHaveBeenCalled();
    fromView.mockRestore();
  });
});

describe('OrdersResolver access rule', () => {
  it('should be open to CUSTOMER and ADMIN callers at class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OrdersResolver)).toEqual([Role.CUSTOMER, Role.ADMIN]);
  });
});
