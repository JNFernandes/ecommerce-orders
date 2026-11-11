import { Logger } from '@nestjs/common';
import { OrderProjectionService } from '../../../src/read-model/order-projection.service';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderView, StoredOrderView } from '../../../src/read-model/order-view';
import { OrderPlacedEvent, OrderConfirmedEvent } from '../../../src/read-model/order-event';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { OrderViewConcurrencyError } from '../../../src/read-model/errors';

const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const PLACED: OrderPlacedEvent = {
  type: 'OrderPlaced',
  eventId: '10000000-0000-4000-8000-000000000001',
  orderId: ORDER_ID,
  occurredAt: new Date('2026-11-11T10:00:00.000Z'),
  customerId: CUSTOMER_ID,
  items: [{ productId: 'p-1', quantity: 1, unitPrice: 10 }],
  totalAmount: 10,
};

const CONFIRMED: OrderConfirmedEvent = {
  type: 'OrderConfirmed',
  eventId: '20000000-0000-4000-8000-000000000002',
  orderId: ORDER_ID,
  occurredAt: new Date('2026-11-11T10:00:01.000Z'),
  customerId: CUSTOMER_ID,
};

function pendingView(): OrderView {
  return {
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    status: OrderViewStatus.PENDING,
    items: [{ productId: 'p-1', quantity: 1, unitPrice: 10, subtotal: 10 }],
    totalAmount: 10,
    placedAt: PLACED.occurredAt,
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: PLACED.occurredAt,
    appliedEventIds: [PLACED.eventId],
    statusEventId: null,
  };
}

function buildService(stored: StoredOrderView | null): {
  service: OrderProjectionService;
  repository: OrderViewRepository;
} {
  const repository = {
    findById: jest.fn().mockResolvedValue(stored),
    insert: jest.fn().mockResolvedValue(undefined),
    replace: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderViewRepository;
  return { service: new OrderProjectionService(repository), repository };
}

describe('OrderProjectionService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should insert a new view when none exists', async () => {
    const { service, repository } = buildService(null);

    const outcome = await service.project(PLACED);

    expect(outcome).toBe('applied');
    expect(repository.findById).toHaveBeenCalledWith(ORDER_ID);
    expect(repository.insert).toHaveBeenCalledWith(pendingView());
    expect(repository.replace).not.toHaveBeenCalled();
  });

  it('should replace an existing view at its stored revision', async () => {
    const { service, repository } = buildService({ view: pendingView(), revision: 3 });

    await service.project(CONFIRMED);

    expect(repository.replace).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderViewStatus.CONFIRMED }),
      3,
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('should log projector warnings', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const confirmedView: OrderView = {
      ...pendingView(),
      status: OrderViewStatus.CONFIRMED,
      confirmedAt: CONFIRMED.occurredAt,
      updatedAt: CONFIRMED.occurredAt,
      appliedEventIds: [PLACED.eventId, CONFIRMED.eventId],
      statusEventId: CONFIRMED.eventId,
    };
    const { service } = buildService({ view: confirmedView, revision: 2 });

    await service.project({
      type: 'OrderCancelled',
      eventId: '30000000-0000-4000-8000-000000000003',
      orderId: ORDER_ID,
      occurredAt: new Date('2026-11-11T10:00:05.000Z'),
      customerId: CUSTOMER_ID,
      reason: null,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0] as string).toContain(ORDER_ID);
  });

  it('should propagate repository errors', async () => {
    const { service, repository } = buildService(null);
    (repository.insert as jest.Mock).mockRejectedValue(new OrderViewConcurrencyError(ORDER_ID));

    await expect(service.project(PLACED)).rejects.toThrow(OrderViewConcurrencyError);
  });
});

describe('OrderProjectionService — duplicates', () => {
  it('should not write anything and report a duplicate when the event was already applied', async () => {
    const { service, repository } = buildService({ view: pendingView(), revision: 1 });

    const outcome = await service.project(PLACED);

    expect(outcome).toBe('duplicate');
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.replace).not.toHaveBeenCalled();
  });
});
