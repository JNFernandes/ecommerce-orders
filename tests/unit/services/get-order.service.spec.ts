import { GetOrderService } from '../../../src/services/get-order.service';
import { GetOrderQuery } from '../../../src/queries/get-order.query';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { ReadModelUnavailableError } from '../../../src/read-model/errors';
import { OrderReadScope } from '../../../src/queries/order-read-scope';
import { Role } from '../../../src/infra/auth/role.enum';

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

const OWNER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ADMIN = OrderReadScope.forCaller({ sub: 'admin', roles: [Role.ADMIN] });
const CUSTOMER = OrderReadScope.forCaller({ sub: 'u', roles: [Role.CUSTOMER], customerId: OWNER });

function serviceWith(findOne: jest.Mock): GetOrderService {
  return new GetOrderService({ findOne } as unknown as OrderViewRepository);
}

describe('GetOrderService', () => {
  it('should return the order view for an admin, looked up without an owner', async () => {
    const findOne = jest.fn().mockResolvedValue(VIEW);

    const result = await serviceWith(findOne).execute(new GetOrderQuery(ADMIN, ORDER_ID));

    expect(result).toBe(VIEW);
    expect(findOne).toHaveBeenCalledWith(ORDER_ID, undefined);
  });

  it('should look the order up by the lowercase id, since UUIDs are case-insensitive', async () => {
    const findOne = jest.fn().mockResolvedValue(VIEW);

    await serviceWith(findOne).execute(new GetOrderQuery(ADMIN, ORDER_ID.toUpperCase()));

    expect(findOne).toHaveBeenCalledWith(ORDER_ID, undefined);
  });

  it('should return null when no order has that id', async () => {
    const findOne = jest.fn().mockResolvedValue(null);

    expect(await serviceWith(findOne).execute(new GetOrderQuery(ADMIN, ORDER_ID))).toBeNull();
  });

  it('should propagate read-model errors', async () => {
    const findOne = jest.fn().mockRejectedValue(new ReadModelUnavailableError(new Error('down')));

    await expect(serviceWith(findOne).execute(new GetOrderQuery(ADMIN, ORDER_ID))).rejects.toThrow(
      ReadModelUnavailableError,
    );
  });

  it("should look a customer's order up together with their id as owner", async () => {
    const findOne = jest.fn().mockResolvedValue(VIEW);

    const result = await serviceWith(findOne).execute(new GetOrderQuery(CUSTOMER, ORDER_ID));

    expect(result).toBe(VIEW);
    expect(findOne).toHaveBeenCalledWith(ORDER_ID, OWNER);
  });

  it("should return null for another customer's order (the owner does not match)", async () => {
    const findOne = jest.fn().mockResolvedValue(null);

    expect(await serviceWith(findOne).execute(new GetOrderQuery(CUSTOMER, ORDER_ID))).toBeNull();
    expect(findOne).toHaveBeenCalledWith(ORDER_ID, OWNER);
  });
});
