import { GetOrderService } from '../../../src/services/get-order.service';
import { GetOrderQuery } from '../../../src/queries/get-order.query';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { ReadModelUnavailableError } from '../../../src/read-model/errors';

const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const VIEW: OrderView = {
  orderId: ORDER_ID,
  customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  status: OrderViewStatus.CONFIRMED,
  items: [{ productId: 'p-1', quantity: 1, unitPrice: 5, subtotal: 5 }],
  totalAmount: 5,
  placedAt: new Date('2026-11-11T10:00:00.000Z'),
  confirmedAt: new Date('2026-11-11T10:00:01.000Z'),
  cancelledAt: null,
  cancellationReason: null,
  updatedAt: new Date('2026-11-11T10:00:01.000Z'),
  appliedEventIds: ['10000000-0000-4000-8000-000000000001'],
  statusEventId: '20000000-0000-4000-8000-000000000002',
};

function serviceWith(findById: jest.Mock): GetOrderService {
  return new GetOrderService({ findById } as unknown as OrderViewRepository);
}

describe('GetOrderService', () => {
  it('should return the order view when the read model has it (not the revision wrapper)', async () => {
    const findById = jest.fn().mockResolvedValue({ view: VIEW, revision: 2 });

    const result = await serviceWith(findById).execute(new GetOrderQuery(ORDER_ID));

    expect(result).toBe(VIEW);
    expect(findById).toHaveBeenCalledWith(ORDER_ID);
  });

  it('should look the order up by the lowercase id, since UUIDs are case-insensitive', async () => {
    const findById = jest.fn().mockResolvedValue({ view: VIEW, revision: 2 });

    await serviceWith(findById).execute(new GetOrderQuery(ORDER_ID.toUpperCase()));

    expect(findById).toHaveBeenCalledWith(ORDER_ID);
  });

  it('should propagate read-model errors', async () => {
    const findById = jest.fn().mockRejectedValue(new ReadModelUnavailableError(new Error('down')));

    await expect(serviceWith(findById).execute(new GetOrderQuery(ORDER_ID))).rejects.toThrow(
      ReadModelUnavailableError,
    );
  });
});
