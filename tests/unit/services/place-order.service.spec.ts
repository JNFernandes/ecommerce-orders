import { NotFoundException } from '@nestjs/common';
import { PlaceOrderService } from '../../../src/services/place-order.service';
import { PlaceOrderCommand } from '../../../src/commands/place-order.command';
import { CustomerRepository } from '../../../src/repositories/customer.repository';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { OrderEventsProducer } from '../../../src/infra/kafka/order-events.producer';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function buildService(overrides?: {
  customerExists?: boolean;
  saveError?: Error;
  publishError?: Error;
}): {
  service: PlaceOrderService;
  customerRepository: CustomerRepository;
  orderRepository: OrderRepository;
  orderEventsProducer: OrderEventsProducer;
  orderDeadLetterRepository: OrderDeadLetterRepository;
} {
  const customerRepository = {
    existsById: jest.fn().mockResolvedValue(overrides?.customerExists ?? true),
  } as unknown as CustomerRepository;

  const orderRepository = {
    save: overrides?.saveError
      ? jest.fn().mockRejectedValue(overrides.saveError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderRepository;

  const orderEventsProducer = {
    publishOrderPlaced: overrides?.publishError
      ? jest.fn().mockRejectedValue(overrides.publishError)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderEventsProducer;

  const orderDeadLetterRepository = {
    recordFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrderDeadLetterRepository;

  const service = new PlaceOrderService(
    customerRepository,
    orderRepository,
    orderEventsProducer,
    orderDeadLetterRepository,
  );

  return {
    service,
    customerRepository,
    orderRepository,
    orderEventsProducer,
    orderDeadLetterRepository,
  };
}

const VALID_ITEMS = [{ productId: 'prod-001', quantity: 2, unitPrice: 29.99 }];

describe('PlaceOrderService', () => {
  // UT-07
  it('should save to DB before publishing to Kafka', async () => {
    const { service, orderRepository, orderEventsProducer } = buildService();
    const callOrder: string[] = [];
    (orderRepository.save as jest.Mock).mockImplementation(async () => {
      callOrder.push('save');
    });
    (orderEventsProducer.publishOrderPlaced as jest.Mock).mockImplementation(async () => {
      callOrder.push('publish');
    });

    await service.execute(new PlaceOrderCommand(CUSTOMER_ID, VALID_ITEMS));

    expect(callOrder).toEqual(['save', 'publish']);
  });

  // UT-09
  it('should return orderId after successful save', async () => {
    const { service } = buildService();

    const result = await service.execute(new PlaceOrderCommand(CUSTOMER_ID, VALID_ITEMS));

    expect(result.orderId).toBeDefined();
    expect(typeof result.orderId).toBe('string');
  });

  // UT-12
  it('should reject and not call Order.place() logic when customer does not exist', async () => {
    const { service, orderRepository } = buildService({ customerExists: false });

    await expect(service.execute(new PlaceOrderCommand(CUSTOMER_ID, VALID_ITEMS))).rejects.toThrow(
      NotFoundException,
    );
    expect(orderRepository.save).not.toHaveBeenCalled();
  });

  // UT-08
  it('should NOT publish to Kafka if DB save fails', async () => {
    const { service, orderEventsProducer } = buildService({ saveError: new Error('db down') });

    await expect(service.execute(new PlaceOrderCommand(CUSTOMER_ID, VALID_ITEMS))).rejects.toThrow(
      'db down',
    );
    expect(orderEventsProducer.publishOrderPlaced).not.toHaveBeenCalled();
  });

  // UT-10
  it('should store event in dead-letter table if Kafka publish fails, and still succeed', async () => {
    const { service, orderDeadLetterRepository } = buildService({
      publishError: new Error('kafka unreachable'),
    });

    const result = await service.execute(new PlaceOrderCommand(CUSTOMER_ID, VALID_ITEMS));

    expect(result.orderId).toBeDefined();
    expect(orderDeadLetterRepository.recordFailure).toHaveBeenCalledTimes(1);
  });
});
