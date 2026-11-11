import { NotFoundException } from '@nestjs/common';
import { CancelOrderService } from '../../../src/services/cancel-order.service';
import { CancelOrderCommand } from '../../../src/commands/cancel-order.command';
import { Order } from '../../../src/domain/order.aggregate';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { OrderCancellationError } from '../../../src/domain/order-cancellation.error';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { OrderEventsProducer } from '../../../src/infra/kafka/order-events.producer';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';
import { InboundEventRef } from '../../../src/commands/inbound-event-ref';
import { OrderCancelled } from '../../../src/domain/events/order-cancelled.event';
import { ProcessedEventOutcome } from '../../../src/infra/database/entities/processed-event.entity';
import { OrderStatusChangedConcurrentlyError } from '../../../src/repositories/errors/order-status-changed-concurrently.error';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function buildPendingOrder(): Order {
  const order = Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }]);
  // A loaded order carries no pending events (the repository reconstitutes it); drain OrderPlaced.
  order.pullDomainEvents();
  return order;
}

function buildService(overrides?: {
  order?: Order | null;
  updateStatusError?: Error;
  applyInboundError?: Error;
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
    applyInboundStatusChange: overrides?.applyInboundError
      ? jest.fn().mockRejectedValue(overrides.applyInboundError)
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

    const result = await service.execute(new CancelOrderCommand('any-order-id'));

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

    await service.execute(new CancelOrderCommand('any-order-id'));

    expect(callOrder).toEqual(['updateStatus', 'publish']);
  });

  it('should throw NotFoundException when the order does not exist', async () => {
    const { service, orderRepository } = buildService({ order: null });

    await expect(service.execute(new CancelOrderCommand('unknown-id'))).rejects.toThrow(
      NotFoundException,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should throw OrderCancellationError when the order is already cancelled', async () => {
    const alreadyCancelled = buildPendingOrder();
    alreadyCancelled.cancel();
    const { service, orderRepository } = buildService({ order: alreadyCancelled });

    await expect(service.execute(new CancelOrderCommand('any-order-id'))).rejects.toThrow(
      OrderCancellationError,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('should NOT publish to Kafka if the status update fails', async () => {
    const { service, orderEventsProducer } = buildService({
      updateStatusError: new Error('db down'),
    });

    await expect(service.execute(new CancelOrderCommand('any-order-id'))).rejects.toThrow(
      'db down',
    );
    expect(orderEventsProducer.publishOrderCancelled).not.toHaveBeenCalled();
  });

  it('should store event in dead-letter table if Kafka publish fails, and still succeed', async () => {
    const { service, orderDeadLetterRepository } = buildService({
      publishError: new Error('kafka unreachable'),
    });

    const result = await service.execute(new CancelOrderCommand('any-order-id'));

    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(orderDeadLetterRepository.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('CancelOrderService (inbound payment-failed event)', () => {
  const reason = 'Amount 15000.00 USD exceeds the maximum allowed threshold of 10000.00 USD.';
  const inboundEvent: InboundEventRef = {
    eventId: '9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3',
    topic: 'payments.payment-failed',
    orderId: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    paymentId: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
  };

  it('should cancel with the reason, save it with the processed event, then publish it', async () => {
    const { service, orderRepository, orderEventsProducer } = buildService();
    const callOrder: string[] = [];
    (orderRepository.applyInboundStatusChange as jest.Mock).mockImplementation(async () => {
      callOrder.push('applyInboundStatusChange');
    });
    (orderEventsProducer.publishOrderCancelled as jest.Mock).mockImplementation(async () => {
      callOrder.push('publish');
    });

    const result = await service.execute(
      new CancelOrderCommand(inboundEvent.orderId, { reason, inboundEvent }),
    );

    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(callOrder).toEqual(['applyInboundStatusChange', 'publish']);
    expect(orderRepository.applyInboundStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderStatus.CANCELLED, cancellationReason: reason }),
      inboundEvent,
      ProcessedEventOutcome.CANCELLED,
    );
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
    const published = (orderEventsProducer.publishOrderCancelled as jest.Mock).mock
      .calls[0][0] as OrderCancelled;
    expect(published.reason).toBe(reason);
  });

  it('should store the event in the dead-letter table if Kafka publish fails, and still succeed', async () => {
    const { service, orderDeadLetterRepository } = buildService({
      publishError: new Error('kafka unreachable'),
    });

    const result = await service.execute(
      new CancelOrderCommand(inboundEvent.orderId, { reason, inboundEvent }),
    );

    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(orderDeadLetterRepository.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('should propagate OrderStatusChangedConcurrentlyError and NOT publish', async () => {
    const { service, orderEventsProducer } = buildService({
      applyInboundError: new OrderStatusChangedConcurrentlyError(inboundEvent.orderId),
    });

    await expect(
      service.execute(new CancelOrderCommand(inboundEvent.orderId, { reason, inboundEvent })),
    ).rejects.toThrow(OrderStatusChangedConcurrentlyError);
    expect(orderEventsProducer.publishOrderCancelled).not.toHaveBeenCalled();
  });

  it('should publish OrderCancelled without a reason for a REST cancellation', async () => {
    const { service, orderEventsProducer } = buildService();

    await service.execute(new CancelOrderCommand('any-order-id'));

    const published = (orderEventsProducer.publishOrderCancelled as jest.Mock).mock
      .calls[0][0] as OrderCancelled;
    expect(JSON.parse(JSON.stringify(published))).not.toHaveProperty('reason');
  });
});
