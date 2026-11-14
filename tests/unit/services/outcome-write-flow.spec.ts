import { Logger } from '@nestjs/common';
import { InboundEventRef } from '../../../src/commands/inbound-event-ref';
import { Order } from '../../../src/domain/order.aggregate';
import { OrderStatus } from '../../../src/domain/order-status.enum';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import { StockOutcome } from '../../../src/domain/stock-outcome.enum';
import { OrderItem } from '../../../src/domain/order-item.value-object';
import {
  Attention,
  OutcomeApplication,
  OutcomeRecord,
} from '../../../src/domain/outcome-application';
import { OrderConfirmed } from '../../../src/domain/events/order-confirmed.event';
import { OrderCancelled } from '../../../src/domain/events/order-cancelled.event';
import { OrderRepository } from '../../../src/repositories/order.repository';
import { ProcessedEventRepository } from '../../../src/repositories/processed-event.repository';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../../../src/infra/kafka/order-events.producer';
import { OrderStatusChangedConcurrentlyError } from '../../../src/repositories/errors/order-status-changed-concurrently.error';
import {
  EventAlreadyProcessedError,
  OrderNotFoundForOutcomeError,
} from '../../../src/services/errors/outcome.errors';
import { ALREADY_PROCESSED, OutcomeWriteFlow } from '../../../src/services/outcome-write-flow';

const ORDER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';
const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function order(
  status: OrderStatus,
  paymentOutcome: PaymentOutcome,
  stockOutcome: StockOutcome,
): Order {
  const created = new Date('2026-11-14T10:00:00.000Z');
  return Order.reconstitute(
    ORDER_ID,
    CUSTOMER_ID,
    status,
    [OrderItem.create('sku-1', 1, 10)],
    10,
    created,
    created,
    null,
    paymentOutcome,
    stockOutcome,
  );
}

const STOCK_REF: InboundEventRef = {
  eventId: '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11',
  topic: 'inventory.stock-reserved',
  orderId: ORDER_ID,
  reservationId: '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33',
};

interface Harness {
  flow: OutcomeWriteFlow;
  calls: string[];
  orderRepository: jest.Mocked<Pick<OrderRepository, 'findById' | 'applyOutcome'>>;
  processedEvents: jest.Mocked<Pick<ProcessedEventRepository, 'exists' | 'recordIgnoredOutcome'>>;
  producer: jest.Mocked<
    Pick<OrderEventsProducer, 'publishOrderConfirmed' | 'publishOrderCancelled'>
  >;
  deadLetters: jest.Mocked<Pick<OrderDeadLetterRepository, 'recordFailure'>>;
}

function harness(loaded: Order | null): Harness {
  const calls: string[] = [];
  const orderRepository = {
    findById: jest.fn().mockResolvedValue(loaded),
    applyOutcome: jest.fn().mockImplementation(async () => {
      calls.push('save');
    }),
  };
  const processedEvents = {
    exists: jest.fn().mockResolvedValue(false),
    recordIgnoredOutcome: jest.fn().mockImplementation(async () => {
      calls.push('recordIgnored');
    }),
  };
  const producer = {
    publishOrderConfirmed: jest.fn().mockImplementation(async () => {
      calls.push('publishConfirmed');
    }),
    publishOrderCancelled: jest.fn().mockImplementation(async () => {
      calls.push('publishCancelled');
    }),
  };
  const deadLetters = { recordFailure: jest.fn().mockResolvedValue(undefined) };
  const flow = new OutcomeWriteFlow(
    orderRepository as unknown as OrderRepository,
    processedEvents as unknown as ProcessedEventRepository,
    producer as unknown as OrderEventsProducer,
    deadLetters as unknown as OrderDeadLetterRepository,
  );
  return { flow, calls, orderRepository, processedEvents, producer, deadLetters };
}

describe('OutcomeWriteFlow', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should skip an event whose eventId was already processed, without loading the order', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.PENDING));
    h.processedEvents.exists.mockResolvedValue(true);
    const apply = jest.fn();

    await expect(h.flow.run(STOCK_REF, apply)).resolves.toBe(ALREADY_PROCESSED);

    expect(h.orderRepository.findById).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('should look the order up by orderId and throw OrderNotFoundForOutcomeError when it does not exist', async () => {
    const h = harness(null);

    await expect(h.flow.run(STOCK_REF, jest.fn())).rejects.toBeInstanceOf(
      OrderNotFoundForOutcomeError,
    );
    expect(h.orderRepository.findById).toHaveBeenCalledWith(ORDER_ID);
    expect(h.orderRepository.findById).not.toHaveBeenCalledWith(STOCK_REF.reservationId);
  });

  it('should save a recorded outcome with the outcomes it was loaded with, and publish nothing', async () => {
    const loaded = order(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.PENDING);
    const h = harness(loaded);

    const result = await h.flow.run(STOCK_REF, (o) => o.recordStockReserved());

    expect(result).toBe(OutcomeRecord.RECORDED);
    expect(h.orderRepository.applyOutcome).toHaveBeenCalledWith(
      loaded,
      { paymentOutcome: PaymentOutcome.PENDING, stockOutcome: StockOutcome.PENDING },
      STOCK_REF,
      OutcomeRecord.RECORDED,
    );
    expect(h.calls).toEqual(['save']);
  });

  it('should save then publish OrderConfirmed when the outcome confirms the order', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING));

    const result = await h.flow.run(STOCK_REF, (o) => o.recordStockReserved());

    expect(result).toBe(OutcomeRecord.CONFIRMED);
    expect(h.calls).toEqual(['save', 'publishConfirmed']);
    expect(h.producer.publishOrderConfirmed.mock.calls[0][0]).toBeInstanceOf(OrderConfirmed);
  });

  it('should save then publish OrderCancelled with the reason when the outcome cancels the order', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.PENDING));

    const result = await h.flow.run(STOCK_REF, (o) => o.recordStockRejected('insufficient stock'));

    expect(result).toBe(OutcomeRecord.CANCELLED);
    expect(h.calls).toEqual(['save', 'publishCancelled']);
    const event = h.producer.publishOrderCancelled.mock.calls[0][0];
    expect(event).toBeInstanceOf(OrderCancelled);
    expect(event.reason).toBe('stock rejected: insufficient stock');
  });

  it.each([
    [OutcomeRecord.IGNORED_DUPLICATE],
    [OutcomeRecord.IGNORED_ALREADY_CONFIRMED],
    [OutcomeRecord.IGNORED_ALREADY_CANCELLED],
    [OutcomeRecord.IGNORED_CONFLICT],
  ])('should store the %s record as given and never save the order or publish', async (record) => {
    const h = harness(
      order(OrderStatus.CONFIRMED, PaymentOutcome.PROCESSED, StockOutcome.RESERVED),
    );
    const decided: OutcomeApplication = { record, attention: Attention.NONE };

    const result = await h.flow.run(STOCK_REF, () => decided);

    expect(result).toBe(record);
    expect(h.processedEvents.recordIgnoredOutcome).toHaveBeenCalledWith(STOCK_REF, record);
    expect(h.orderRepository.applyOutcome).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['recordIgnored']);
  });

  it('should log an ignored outcome that needs no attention at informational level', async () => {
    const h = harness(order(OrderStatus.CANCELLED, PaymentOutcome.FAILED, StockOutcome.PENDING));

    await h.flow.run(STOCK_REF, (o) => o.recordStockReserved());

    expect(warnSpy).not.toHaveBeenCalled();
    const message = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(message).toContain(ORDER_ID);
    expect(message).toContain('CANCELLED');
    expect(message).toContain(`reservationId=${STOCK_REF.reservationId}`);
  });

  it('should warn with a searchable "payment needs refund:" prefix when a payment succeeds for a cancelled order', async () => {
    const h = harness(order(OrderStatus.CANCELLED, PaymentOutcome.PENDING, StockOutcome.REJECTED));
    const paymentRef: InboundEventRef = {
      eventId: '1c7e5a43-6b1d-4c8e-8a2e-3e9b7d4f5a21',
      topic: 'payments.payment-processed',
      orderId: ORDER_ID,
      paymentId: '11111111-1111-4111-8111-111111111111',
    };

    const result = await h.flow.run(paymentRef, (o) => o.recordPaymentProcessed());

    expect(result).toBe(OutcomeRecord.IGNORED_CONFLICT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message.startsWith('payment needs refund:')).toBe(true);
    expect(message).toContain('paymentId=11111111-1111-4111-8111-111111111111');
  });

  it('should warn about a conflicting outcome', async () => {
    const h = harness(
      order(OrderStatus.CONFIRMED, PaymentOutcome.PROCESSED, StockOutcome.RESERVED),
    );

    await h.flow.run(STOCK_REF, (o) => o.recordStockRejected('insufficient stock'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('conflicting');
  });

  it('should dead-letter the event and still succeed when publishing fails after the save', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING));
    const failure = new Error('broker down');
    h.producer.publishOrderConfirmed.mockRejectedValue(failure);

    const result = await h.flow.run(STOCK_REF, (o) => o.recordStockReserved());

    expect(result).toBe(OutcomeRecord.CONFIRMED);
    expect(h.deadLetters.recordFailure).toHaveBeenCalledWith(
      ORDER_CONFIRMED_TOPIC,
      expect.any(OrderConfirmed),
      failure,
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('should dead-letter a failed OrderCancelled publish on the cancelled topic', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PENDING, StockOutcome.PENDING));
    h.producer.publishOrderCancelled.mockRejectedValue(new Error('broker down'));

    await h.flow.run(STOCK_REF, (o) => o.recordStockRejected('insufficient stock'));

    expect(h.deadLetters.recordFailure).toHaveBeenCalledWith(
      ORDER_CANCELLED_TOPIC,
      expect.any(OrderCancelled),
      expect.any(Error),
    );
  });

  it('should not publish when the save fails, and let a concurrent-change error propagate for a retry', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING));
    h.orderRepository.applyOutcome.mockRejectedValue(
      new OrderStatusChangedConcurrentlyError(ORDER_ID),
    );

    await expect(h.flow.run(STOCK_REF, (o) => o.recordStockReserved())).rejects.toBeInstanceOf(
      OrderStatusChangedConcurrentlyError,
    );
    expect(h.producer.publishOrderConfirmed).not.toHaveBeenCalled();
  });

  it('should return ALREADY_PROCESSED when the eventId is recorded concurrently by another handler', async () => {
    const h = harness(order(OrderStatus.PENDING, PaymentOutcome.PROCESSED, StockOutcome.PENDING));
    h.orderRepository.applyOutcome.mockRejectedValue(
      new EventAlreadyProcessedError(STOCK_REF.eventId),
    );

    await expect(h.flow.run(STOCK_REF, (o) => o.recordStockReserved())).resolves.toBe(
      ALREADY_PROCESSED,
    );
    expect(h.producer.publishOrderConfirmed).not.toHaveBeenCalled();
  });

  it('should return ALREADY_PROCESSED when an ignored outcome races with the same eventId', async () => {
    const h = harness(order(OrderStatus.CANCELLED, PaymentOutcome.FAILED, StockOutcome.PENDING));
    h.processedEvents.recordIgnoredOutcome.mockRejectedValue(
      new EventAlreadyProcessedError(STOCK_REF.eventId),
    );

    await expect(h.flow.run(STOCK_REF, (o) => o.recordStockReserved())).resolves.toBe(
      ALREADY_PROCESSED,
    );
  });
});
