import { NotFoundException } from '@nestjs/common';
import { CancelOrderService } from '../../../src/services/cancel-order.service';
import { CancelOrderCommand } from '../../../src/commands/cancel-order.command';
import { Order } from '../../../src/domain/order.aggregate';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { OrderCancellationError } from '../../../src/domain/order-cancellation.error';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { OrderEventsProducer } from '../../../src/infra/kafka/order-events.producer';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';
import { OrderCancelled } from '../../../src/domain/events/order-cancelled.event';
import { OrderRequester } from '../../../src/domain/order-requester';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OWNER: OrderRequester = { customerId: CUSTOMER_ID, isAdmin: false };
const OTHER_CUSTOMER: OrderRequester = { customerId: OTHER_CUSTOMER_ID, isAdmin: false };
const ADMIN: OrderRequester = { customerId: null, isAdmin: true };

function buildPendingOrder(): Order {
  const order = Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }]);
  // A loaded order carries no pending events (the repository reconstitutes it); drain OrderPlaced.
  order.pullDomainEvents();
  return order;
}

function buildService(overrides?: {
  order?: Order | null;
  updateStatusError?: Error;
  publishError?: Error;
}): {
  service: CancelOrderService;
  orderRepository: OrderRepository;
  orderEventsProducer: OrderEventsProducer;
  orderDeadLetterRepository: OrderDeadLetterRepository;
} {
  const order = overrides?.order === undefined ? buildPendingOrder() : overrides.order;

  const orderRepository = {
    findById: jest.fn().mockResolvedValue(order),
    updateStatus: overrides?.updateStatusError
      ? jest.fn().mockRejectedValue(overrides.updateStatusError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderRepository;

  const orderEventsProducer = {
    publishOrderCancelled: overrides?.publishError
      ? jest.fn().mockRejectedValue(overrides.publishError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderEventsProducer;

  const orderDeadLetterRepository = {
    recordFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderDeadLetterRepository;

  const service = new CancelOrderService(
    orderRepository,
    orderEventsProducer,
    orderDeadLetterRepository,
  );

  return { service, orderRepository, orderEventsProducer, orderDeadLetterRepository };
}

describe('CancelOrderService', () => {
  it('should cancel a PENDING order and return CANCELLED status', async () => {
    const { service } = buildService();

    const result = await service.execute(new CancelOrderCommand('any-order-id', OWNER));

    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('should update the order status before publishing to Kafka', async () => {
    const { service, orderRepository, orderEventsProducer } = buildService();
    const callOrder: string[] = [];
    (orderRepository.updateStatus as jest.Mock).mockImplementation(async () => {
      callOrder.push('updateStatus');
    });
    (orderEventsProducer.publishOrderCancelled as jest.Mock).mockImplementation(async () => {
      callOrder.push('publish');
    });

    await service.execute(new CancelOrderCommand('any-order-id', OWNER));

    expect(callOrder).toEqual(['updateStatus', 'publish']);
  });

  it('should throw NotFoundException when the order does not exist', async () => {
    const { service, orderRepository } = buildService({ order: null });

    await expect(service.execute(new CancelOrderCommand('unknown-id', OWNER))).rejects.toThrow(
      NotFoundException,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should throw OrderCancellationError when the order is already cancelled', async () => {
    const alreadyCancelled = buildPendingOrder();
    alreadyCancelled.cancel();
    const { service, orderRepository } = buildService({ order: alreadyCancelled });

    await expect(service.execute(new CancelOrderCommand('any-order-id', OWNER))).rejects.toThrow(
      OrderCancellationError,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should NOT publish to Kafka if the status update fails', async () => {
    const { service, orderEventsProducer } = buildService({
      updateStatusError: new Error('db down'),
    });

    await expect(service.execute(new CancelOrderCommand('any-order-id', OWNER))).rejects.toThrow(
      'db down',
    );
    expect(orderEventsProducer.publishOrderCancelled).not.toHaveBeenCalled();
  });

  it('should store event in dead-letter table if Kafka publish fails, and still succeed', async () => {
    const { service, orderDeadLetterRepository } = buildService({
      publishError: new Error('kafka unreachable'),
    });

    const result = await service.execute(new CancelOrderCommand('any-order-id', OWNER));

    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(orderDeadLetterRepository.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('should publish OrderCancelled without a reason for a REST cancellation', async () => {
    const { service, orderEventsProducer } = buildService();

    await service.execute(new CancelOrderCommand('any-order-id', OWNER));

    const published = (orderEventsProducer.publishOrderCancelled as jest.Mock).mock
      .calls[0][0] as OrderCancelled;
    expect(JSON.parse(JSON.stringify(published))).not.toHaveProperty('reason');
  });

  describe('ownership (US-11)', () => {
    it("should answer another customer's order with the same NotFoundException as a missing one", async () => {
      const missing = buildService({ order: null });
      const notMine = buildService();

      const missingError = await missing.service
        .execute(new CancelOrderCommand('unknown-id', OTHER_CUSTOMER))
        .catch((error: unknown) => error);
      const notMineError = await notMine.service
        .execute(new CancelOrderCommand('any-order-id', OTHER_CUSTOMER))
        .catch((error: unknown) => error);

      expect(notMineError).toBeInstanceOf(NotFoundException);
      expect((notMineError as NotFoundException).getResponse()).toEqual(
        (missingError as NotFoundException).getResponse(),
      );
      expect(notMine.orderRepository.updateStatus).not.toHaveBeenCalled();
      expect(notMine.orderEventsProducer.publishOrderCancelled).not.toHaveBeenCalled();
    });

    it('should let the owner cancel their order', async () => {
      const { service, orderEventsProducer } = buildService();

      const result = await service.execute(new CancelOrderCommand('any-order-id', OWNER));

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(orderEventsProducer.publishOrderCancelled).toHaveBeenCalledTimes(1);
    });

    it("should let an admin cancel any customer's order", async () => {
      const { service } = buildService();

      const result = await service.execute(new CancelOrderCommand('any-order-id', ADMIN));

      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('should still raise OrderCancellationError for the owner of a non-PENDING order', async () => {
      const alreadyCancelled = buildPendingOrder();
      alreadyCancelled.cancel();
      const { service } = buildService({ order: alreadyCancelled });

      await expect(service.execute(new CancelOrderCommand('any-order-id', OWNER))).rejects.toThrow(
        OrderCancellationError,
      );
    });
  });
});
