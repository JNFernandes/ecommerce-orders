import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ReactToPaymentOutcomeService } from '../../../src/services/react-to-payment-outcome.service';
import { ReactToPaymentOutcomeCommand } from '../../../src/commands/react-to-payment-outcome.command';
import { ConfirmOrderCommand } from '../../../src/commands/confirm-order.command';
import { CancelOrderCommand } from '../../../src/commands/cancel-order.command';
import { InboundEventRef } from '../../../src/commands/inbound-event-ref';
import { Order } from '../../../src/domain/order.aggregate';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { ProcessedEventRepository } from '../../../src/repositories/processed-event.repository';
import { ProcessedEventOutcome } from '../../../src/infra/database/entities/processed-event.entity';
import {
  EventAlreadyProcessedError,
  OrderNotFoundForPaymentError,
} from '../../../src/services/errors/payment-outcome.errors';
import { ALREADY_PROCESSED } from '../../../src/services/react-to-payment-outcome.service';

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function pendingOrder(): Order {
  return Order.place(CUSTOMER_ID, [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }]);
}

function confirmedOrder(): Order {
  const order = pendingOrder();
  order.confirm();
  order.pullDomainEvents();
  return order;
}

function cancelledOrder(): Order {
  const order = pendingOrder();
  order.cancel();
  order.pullDomainEvents();
  return order;
}

function inboundFor(orderId: string, topic = 'payments.payment-processed'): InboundEventRef {
  return {
    eventId: '9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3',
    topic,
    orderId,
    paymentId: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
  };
}

function buildService(order: Order | null): {
  service: ReactToPaymentOutcomeService;
  commandBus: CommandBus;
  orderRepository: OrderRepository;
  processedEventRepository: ProcessedEventRepository;
} {
  const commandBus = {
    execute: jest.fn().mockResolvedValue(undefined),
  } as unknown as CommandBus;
  const orderRepository = {
    findById: jest.fn().mockResolvedValue(order),
  } as unknown as OrderRepository;
  const processedEventRepository = {
    exists: jest.fn().mockResolvedValue(false),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProcessedEventRepository;

  const service = new ReactToPaymentOutcomeService(
    commandBus,
    orderRepository,
    processedEventRepository,
  );
  return { service, commandBus, orderRepository, processedEventRepository };
}

describe('ReactToPaymentOutcomeService — payment processed', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should dispatch ConfirmOrderCommand with the inbound event when the order is PENDING', async () => {
    const order = pendingOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id);

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ProcessedEventOutcome.CONFIRMED);
    expect(commandBus.execute).toHaveBeenCalledWith(new ConfirmOrderCommand(order.id, inbound));
    expect(processedEventRepository.recordOutcome).not.toHaveBeenCalled();
  });

  it('should record IGNORED_ALREADY_CONFIRMED and dispatch nothing when the order is already CONFIRMED', async () => {
    const order = confirmedOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id);

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ProcessedEventOutcome.IGNORED_ALREADY_CONFIRMED);
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(processedEventRepository.recordOutcome).toHaveBeenCalledWith(
      inbound,
      ProcessedEventOutcome.IGNORED_ALREADY_CONFIRMED,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should record IGNORED_CONFLICT and log a warning when the order is CANCELLED', async () => {
    const order = cancelledOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id);

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ProcessedEventOutcome.IGNORED_CONFLICT);
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(processedEventRepository.recordOutcome).toHaveBeenCalledWith(
      inbound,
      ProcessedEventOutcome.IGNORED_CONFLICT,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain(inbound.orderId);
    expect(message).toContain(inbound.paymentId);
    expect(message).toContain(inbound.eventId);
  });

  it('should throw OrderNotFoundForPaymentError when no order matches orderId', async () => {
    const { service, commandBus } = buildService(null);
    const inbound = inboundFor('b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d');

    await expect(
      service.execute(new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound)),
    ).rejects.toThrow(OrderNotFoundForPaymentError);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('should look the order up by orderId only, never by the payment id (aggregateId)', async () => {
    const order = pendingOrder();
    const { service, orderRepository } = buildService(order);
    const inbound = inboundFor(order.id);

    await service.execute(new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound));

    expect(orderRepository.findById).toHaveBeenCalledTimes(1);
    expect(orderRepository.findById).toHaveBeenCalledWith(inbound.orderId);
    expect(orderRepository.findById).not.toHaveBeenCalledWith(inbound.paymentId);
  });
});

describe('ReactToPaymentOutcomeService — payment failed', () => {
  const reason = 'Amount exceeds threshold';
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should dispatch CancelOrderCommand with the reason and inbound event when the order is PENDING', async () => {
    const order = pendingOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id, 'payments.payment-failed');

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.FAILED, inbound, reason),
    );

    expect(result).toBe(ProcessedEventOutcome.CANCELLED);
    expect(commandBus.execute).toHaveBeenCalledWith(
      new CancelOrderCommand(order.id, { reason, inboundEvent: inbound }),
    );
    expect(processedEventRepository.recordOutcome).not.toHaveBeenCalled();
  });

  it('should pass an empty reason when the failed payment carried none', async () => {
    const order = pendingOrder();
    const { service, commandBus } = buildService(order);
    const inbound = inboundFor(order.id, 'payments.payment-failed');

    await service.execute(new ReactToPaymentOutcomeCommand(PaymentOutcome.FAILED, inbound));

    const command = (commandBus.execute as jest.Mock).mock.calls[0][0] as CancelOrderCommand;
    expect(command.reason).toBe('');
  });

  it('should record IGNORED_ALREADY_CANCELLED and dispatch nothing when the order is already CANCELLED', async () => {
    const order = cancelledOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id, 'payments.payment-failed');

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.FAILED, inbound, reason),
    );

    expect(result).toBe(ProcessedEventOutcome.IGNORED_ALREADY_CANCELLED);
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(processedEventRepository.recordOutcome).toHaveBeenCalledWith(
      inbound,
      ProcessedEventOutcome.IGNORED_ALREADY_CANCELLED,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should record IGNORED_CONFLICT and log a warning when the order is CONFIRMED', async () => {
    const order = confirmedOrder();
    const { service, commandBus, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id, 'payments.payment-failed');

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.FAILED, inbound, reason),
    );

    expect(result).toBe(ProcessedEventOutcome.IGNORED_CONFLICT);
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(processedEventRepository.recordOutcome).toHaveBeenCalledWith(
      inbound,
      ProcessedEventOutcome.IGNORED_CONFLICT,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0] as string).toContain(inbound.paymentId);
  });
});

describe('ReactToPaymentOutcomeService — duplicates', () => {
  it('should return ALREADY_PROCESSED without loading the order when the eventId was already processed', async () => {
    const order = pendingOrder();
    const { service, commandBus, orderRepository, processedEventRepository } = buildService(order);
    (processedEventRepository.exists as jest.Mock).mockResolvedValue(true);
    const inbound = inboundFor(order.id);

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ALREADY_PROCESSED);
    expect(processedEventRepository.exists).toHaveBeenCalledWith(inbound.eventId);
    expect(orderRepository.findById).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('should treat EventAlreadyProcessedError from the dispatched command as already processed', async () => {
    const order = pendingOrder();
    const { service, commandBus } = buildService(order);
    const inbound = inboundFor(order.id);
    (commandBus.execute as jest.Mock).mockRejectedValue(
      new EventAlreadyProcessedError(inbound.eventId),
    );

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ALREADY_PROCESSED);
  });

  it('should treat EventAlreadyProcessedError while recording a no-op as already processed', async () => {
    const order = confirmedOrder();
    const { service, processedEventRepository } = buildService(order);
    const inbound = inboundFor(order.id);
    (processedEventRepository.recordOutcome as jest.Mock).mockRejectedValue(
      new EventAlreadyProcessedError(inbound.eventId),
    );

    const result = await service.execute(
      new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inbound),
    );

    expect(result).toBe(ALREADY_PROCESSED);
  });

  it('should still propagate other errors from the dispatched command', async () => {
    const order = pendingOrder();
    const { service, commandBus } = buildService(order);
    (commandBus.execute as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(
      service.execute(
        new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, inboundFor(order.id)),
      ),
    ).rejects.toThrow('db down');
  });
});
