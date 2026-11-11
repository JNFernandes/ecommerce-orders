import { ListOrdersService } from '../../../src/services/list-orders.service';
import { ListOrdersQuery } from '../../../src/queries/list-orders.query';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { ReadModelUnavailableError } from '../../../src/read-model/errors';

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
  it('should pass the filter and page through to the read-model repository', async () => {
    const { service, list } = serviceReturning([], 0);
    const filter = { status: OrderViewStatus.CANCELLED, customerId: 'c-1' };
    const page = { limit: 10, offset: 30 };

    await service.execute(new ListOrdersQuery(filter, page));

    expect(list).toHaveBeenCalledWith(filter, page);
  });

  it('should return the views and total count from the repository', async () => {
    const views = [view(1), view(2)];
    const { service } = serviceReturning(views, 5);

    const result = await service.execute(new ListOrdersQuery({}, { limit: 2, offset: 0 }));

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

    const result = await service.execute(new ListOrdersQuery({}, { limit: 2, offset }));

    expect(result.hasNextPage).toBe(expected);
  });

  it('should propagate read-model errors', async () => {
    const list = jest.fn().mockRejectedValue(new ReadModelUnavailableError(new Error('down')));
    const service = new ListOrdersService({ list } as unknown as OrderViewRepository);

    await expect(
      service.execute(new ListOrdersQuery({}, { limit: 20, offset: 0 })),
    ).rejects.toThrow(ReadModelUnavailableError);
  });
});
