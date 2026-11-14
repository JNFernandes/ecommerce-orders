import { NotFoundException } from '@nestjs/common';
import { ConfirmOrderService } from '../../../src/services/confirm-order.service';
import { ConfirmOrderCommand } from '../../../src/commands/confirm-order.command';
import { Order } from '../../../src/domain/order.aggregate';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { OrderConfirmationError } from '../../../src/domain/order-confirmation.error';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { OrderEventsProducer } from '../../../src/infra/kafka/order-events.producer';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function buildPendingOrder(): Order {
  return Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }]);
}

function buildService(overrides?: {
  order?: Order | null;
  updateStatusError?: Error;
  publishError?: Error;
}): {
  service: ConfirmOrderService;
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
    publishOrderConfirmed: overrides?.publishError
      ? jest.fn().mockRejectedValue(overrides.publishError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderEventsProducer;

  const orderDeadLetterRepository = {
    recordFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderDeadLetterRepository;

  const service = new ConfirmOrderService(
    orderRepository,
    orderEventsProducer,
    orderDeadLetterRepository,
  );

  return { service, orderRepository, orderEventsProducer, orderDeadLetterRepository };
}

describe('ConfirmOrderService', () => {
  it('should confirm a PENDING order and return CONFIRMED status', async () => {
    const { service } = buildService();

    const result = await service.execute(new ConfirmOrderCommand('any-order-id'));

    expect(result.status).toBe(OrderStatus.CONFIRMED);
  });

  it('should update the order status before publishing to Kafka', async () => {
    const { service, orderRepository, orderEventsProducer } = buildService();
    const callOrder: string[] = [];
    (orderRepository.updateStatus as jest.Mock).mockImplementation(async () => {
      callOrder.push('updateStatus');
    });
    (orderEventsProducer.publishOrderConfirmed as jest.Mock).mockImplementation(async () => {
      callOrder.push('publish');
    });

    await service.execute(new ConfirmOrderCommand('any-order-id'));

    expect(callOrder).toEqual(['updateStatus', 'publish']);
  });

  it('should throw NotFoundException when the order does not exist', async () => {
    const { service, orderRepository } = buildService({ order: null });

    await expect(service.execute(new ConfirmOrderCommand('unknown-id'))).rejects.toThrow(
      NotFoundException,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should throw OrderConfirmationError when the order is already confirmed', async () => {
    const alreadyConfirmed = buildPendingOrder();
    alreadyConfirmed.confirm();
    const { service, orderRepository } = buildService({ order: alreadyConfirmed });

    await expect(service.execute(new ConfirmOrderCommand('any-order-id'))).rejects.toThrow(
      OrderConfirmationError,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should throw OrderConfirmationError when the order is already cancelled', async () => {
    const alreadyCancelled = buildPendingOrder();
    alreadyCancelled.cancel();
    const { service, orderRepository } = buildService({ order: alreadyCancelled });

    await expect(service.execute(new ConfirmOrderCommand('any-order-id'))).rejects.toThrow(
      OrderConfirmationError,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should NOT publish to Kafka if the status update fails', async () => {
    const { service, orderEventsProducer } = buildService({
      updateStatusError: new Error('db down'),
    });

    await expect(service.execute(new ConfirmOrderCommand('any-order-id'))).rejects.toThrow(
      'db down',
    );
    expect(orderEventsProducer.publishOrderConfirmed).not.toHaveBeenCalled();
  });

  it('should store event in dead-letter table if Kafka publish fails, and still succeed', async () => {
    const { service, orderDeadLetterRepository } = buildService({
      publishError: new Error('kafka unreachable'),
    });

    const result = await service.execute(new ConfirmOrderCommand('any-order-id'));

    expect(result.status).toBe(OrderStatus.CONFIRMED);
    expect(orderDeadLetterRepository.recordFailure).toHaveBeenCalledTimes(1);
  });
});
