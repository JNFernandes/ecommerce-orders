import { ListOrdersService } from '../../../src/services/list-orders.service';
import { ListOrdersQuery } from '../../../src/queries/list-orders.query';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { ReadModelUnavailableError } from '../../../src/read-model/errors';
import { OrderReadScope } from '../../../src/queries/order-read-scope';
import { Role } from '../../../src/infra/auth/role.enum';

const OWN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER = '11111111-2222-4333-8444-555555555555';
const ADMIN = OrderReadScope.forCaller({ sub: 'admin', roles: [Role.ADMIN] });
const CUSTOMER = OrderReadScope.forCaller({ sub: 'u', roles: [Role.CUSTOMER], customerId: OWN });

function view(n: number): OrderView {
  return {
    orderId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    status: OrderViewStatus.PENDING,
    items: [],
    totalAmount: 1,
    placedAt: new Date(),
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: new Date(),
    appliedEventIds: [],
    statusEventId: null,
  };
}

function serviceReturning(
  views: OrderView[],
  totalCount: number,
): {
  service: ListOrdersService;
  list: jest.Mock;
} {
  const list = jest.fn().mockResolvedValue({ views, totalCount });
  const repository = { list } as unknown as OrderViewRepository;
  return { service: new ListOrdersService(repository), list };
}

describe('ListOrdersService', () => {
  it('should pass the filter and page through unchanged for an admin', async () => {
    const { service, list } = serviceReturning([], 0);
    const filter = { status: OrderViewStatus.CANCELLED, customerId: 'c-1' };
    const page = { limit: 10, offset: 30 };

    await service.execute(new ListOrdersQuery(ADMIN, filter, page));

    expect(list).toHaveBeenCalledWith(filter, page);
  });

  it('should return the views and total count from the repository', async () => {
    const views = [view(1), view(2)];
    const { service } = serviceReturning(views, 5);

    const result = await service.execute(new ListOrdersQuery(ADMIN, {}, { limit: 2, offset: 0 }));

    expect(result.views).toBe(views);
    expect(result.totalCount).toBe(5);
  });

  it.each([
    ['an empty result', 0, 0, 0, false],
    ['a partial page with more left', 0, 2, 5, true],
    ['the exact last page', 4, 1, 5, false],
    ['a full page that ends exactly at the total', 3, 2, 5, false],
    ['an offset beyond the end', 10, 0, 5, false],
  ])('should compute hasNextPage for %s', async (_label, offset, returned, total, expected) => {
    const views = Array.from({ length: returned }, (_unused, i) => view(i));
    const { service } = serviceReturning(views, total);

    const result = await service.execute(new ListOrdersQuery(ADMIN, {}, { limit: 2, offset }));

    expect(result.hasNextPage).toBe(expected);
  });

  it('should propagate read-model errors', async () => {
    const list = jest.fn().mockRejectedValue(new ReadModelUnavailableError(new Error('down')));
    const service = new ListOrdersService({ list } as unknown as OrderViewRepository);

    await expect(
      service.execute(new ListOrdersQuery(ADMIN, {}, { limit: 20, offset: 0 })),
    ).rejects.toThrow(ReadModelUnavailableError);
  });

  describe('scoped to a customer', () => {
    it("should restrict the list to the customer's own orders", async () => {
      const { service, list } = serviceReturning([], 0);
      const page = { limit: 20, offset: 0 };

      await service.execute(
        new ListOrdersQuery(CUSTOMER, { status: OrderViewStatus.PENDING }, page),
      );

      expect(list).toHaveBeenCalledWith({ status: OrderViewStatus.PENDING, customerId: OWN }, page);
    });

    it("should treat a filter on the customer's own id like no filter", async () => {
      const { service, list } = serviceReturning([], 0);

      await service.execute(
        new ListOrdersQuery(CUSTOMER, { customerId: OWN.toUpperCase() }, { limit: 20, offset: 0 }),
      );

      expect(list).toHaveBeenCalledWith({ customerId: OWN }, { limit: 20, offset: 0 });
    });

    it("should answer another customer's id with an empty page, without calling the repository", async () => {
      const { service, list } = serviceReturning([view(1)], 1);

      const result = await service.execute(
        new ListOrdersQuery(
          CUSTOMER,
          { customerId: OTHER, status: OrderViewStatus.CONFIRMED },
          { limit: 20, offset: 0 },
        ),
      );

      expect(result).toEqual({ views: [], totalCount: 0, hasNextPage: false });
      expect(list).not.toHaveBeenCalled();
    });

    it("should compute hasNextPage over the customer's orders only", async () => {
      const { service } = serviceReturning([view(1), view(2)], 3);

      const result = await service.execute(
        new ListOrdersQuery(CUSTOMER, {}, { limit: 2, offset: 0 }),
      );

      expect(result.totalCount).toBe(3);
      expect(result.hasNextPage).toBe(true);
    });
  });
});
