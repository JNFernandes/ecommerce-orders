import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Order } from '../../src/domain/order.aggregate';
import { OrderStatus } from '../../src/domain/order-status.enum';
import { PaymentOutcome } from '../../src/domain/payment-outcome.enum';
import { StockOutcome } from '../../src/domain/stock-outcome.enum';
import { OutcomeRecord } from '../../src/domain/outcome-application';
import { InboundEventRef } from '../../src/commands/inbound-event-ref';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderStatusChangedConcurrentlyError } from '../../src/repositories/errors/order-status-changed-concurrently.error';
import { EventAlreadyProcessedError } from '../../src/services/errors/payment-outcome.errors';

jest.setTimeout(180_000);

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('OrderRepository — outcomes (integration, real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: OrderRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [OrderEntity, OrderItemEntity, ProcessedEventEntity],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new OrderRepository(dataSource.getRepository(OrderEntity), dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  async function savedOrder(): Promise<Order> {
    const order = Order.place(CUSTOMER_ID, [{ productId: 'sku-1', quantity: 1, unitPrice: 10 }]);
    order.pullDomainEvents();
    await repository.save(order);
    return order;
  }

  function stockRef(orderId: string): InboundEventRef {
    return {
      eventId: randomUUID(),
      topic: 'inventory.stock-reserved',
      orderId,
      reservationId: randomUUID(),
    };
  }

  function paymentRef(orderId: string): InboundEventRef {
    return {
      eventId: randomUUID(),
      topic: 'payments.payment-processed',
      orderId,
      paymentId: randomUUID(),
    };
  }

  async function processedRow(eventId: string): Promise<ProcessedEventEntity | null> {
    return dataSource.getRepository(ProcessedEventEntity).findOneBy({ eventId });
  }

  it('should save a new order with both outcomes PENDING and load them back', async () => {
    const order = await savedOrder();

    const loaded = await repository.findById(order.id);

    expect(loaded?.paymentOutcome).toBe(PaymentOutcome.PENDING);
    expect(loaded?.stockOutcome).toBe(StockOutcome.PENDING);
  });

  it('should persist a first positive outcome with its processed-event row (reservation id, no payment id)', async () => {
    const { id } = await savedOrder();
    const order = (await repository.findById(id)) as Order;
    const loaded = { paymentOutcome: order.paymentOutcome, stockOutcome: order.stockOutcome };
    const inbound = stockRef(id);

    const { record } = order.recordStockReserved();
    await repository.applyOutcome(order, loaded, inbound, record);

    const reloaded = await repository.findById(id);
    expect(reloaded?.status).toBe(OrderStatus.PENDING);
    expect(reloaded?.stockOutcome).toBe(StockOutcome.RESERVED);
    expect(reloaded?.paymentOutcome).toBe(PaymentOutcome.PENDING);
    const row = await processedRow(inbound.eventId);
    expect(row).toMatchObject({
      orderId: id,
      topic: 'inventory.stock-reserved',
      reservationId: inbound.reservationId,
      paymentId: null,
      outcome: 'RECORDED',
    });
  });

  it('should persist a confirmation driven by the second positive outcome', async () => {
    const { id } = await savedOrder();
    const first = (await repository.findById(id)) as Order;
    first.recordPaymentProcessed();
    await repository.applyOutcome(
      first,
      { paymentOutcome: PaymentOutcome.PENDING, stockOutcome: StockOutcome.PENDING },
      paymentRef(id),
      OutcomeRecord.RECORDED,
    );

    const second = (await repository.findById(id)) as Order;
    const loaded = { paymentOutcome: second.paymentOutcome, stockOutcome: second.stockOutcome };
    const { record } = second.recordStockReserved();
    await repository.applyOutcome(second, loaded, stockRef(id), record);

    const reloaded = await repository.findById(id);
    expect(reloaded?.status).toBe(OrderStatus.CONFIRMED);
    expect(reloaded?.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(reloaded?.stockOutcome).toBe(StockOutcome.RESERVED);
  });

  it('should persist a cancellation with its reason', async () => {
    const { id } = await savedOrder();
    const order = (await repository.findById(id)) as Order;
    const loaded = { paymentOutcome: order.paymentOutcome, stockOutcome: order.stockOutcome };

    const { record } = order.recordStockRejected('insufficient stock');
    await repository.applyOutcome(order, loaded, stockRef(id), record);

    const reloaded = await repository.findById(id);
    expect(reloaded?.status).toBe(OrderStatus.CANCELLED);
    expect(reloaded?.stockOutcome).toBe(StockOutcome.REJECTED);
    expect(reloaded?.cancellationReason).toBe('stock rejected: insufficient stock');
  });

  it('should reject a write based on stale outcomes and leave the stored order unchanged', async () => {
    const { id } = await savedOrder();
    // Two handlers load the same PENDING order at the same time.
    const paymentSide = (await repository.findById(id)) as Order;
    const stockSide = (await repository.findById(id)) as Order;
    const loaded = { paymentOutcome: PaymentOutcome.PENDING, stockOutcome: StockOutcome.PENDING };

    paymentSide.recordPaymentProcessed();
    await repository.applyOutcome(paymentSide, loaded, paymentRef(id), OutcomeRecord.RECORDED);

    stockSide.recordStockReserved();
    const staleRef = stockRef(id);
    await expect(
      repository.applyOutcome(stockSide, loaded, staleRef, OutcomeRecord.RECORDED),
    ).rejects.toBeInstanceOf(OrderStatusChangedConcurrentlyError);

    const reloaded = await repository.findById(id);
    expect(reloaded?.paymentOutcome).toBe(PaymentOutcome.PROCESSED);
    expect(reloaded?.stockOutcome).toBe(StockOutcome.PENDING);
    expect(await processedRow(staleRef.eventId)).toBeNull();
  });

  it('should reject an outcome write for an order that is no longer PENDING', async () => {
    const { id } = await savedOrder();
    await repository.updateStatus(id, OrderStatus.CANCELLED, new Date());
    const order = (await repository.findById(id)) as Order;
    // Simulate a handler that loaded the order before the REST cancel.
    const stale = Order.reconstitute(
      order.id,
      order.customerId,
      OrderStatus.PENDING,
      order.items,
      order.totalAmount,
      order.createdAt,
      order.updatedAt,
    );
    stale.recordStockReserved();

    await expect(
      repository.applyOutcome(
        stale,
        { paymentOutcome: PaymentOutcome.PENDING, stockOutcome: StockOutcome.PENDING },
        stockRef(id),
        OutcomeRecord.RECORDED,
      ),
    ).rejects.toBeInstanceOf(OrderStatusChangedConcurrentlyError);
  });

  it('should reject a duplicate eventId and roll back the order change', async () => {
    const { id } = await savedOrder();
    const inbound = stockRef(id);
    const first = (await repository.findById(id)) as Order;
    first.recordStockReserved();
    await repository.applyOutcome(
      first,
      { paymentOutcome: PaymentOutcome.PENDING, stockOutcome: StockOutcome.PENDING },
      inbound,
      OutcomeRecord.RECORDED,
    );

    const second = (await repository.findById(id)) as Order;
    const loaded = { paymentOutcome: second.paymentOutcome, stockOutcome: second.stockOutcome };
    second.recordPaymentProcessed();
    await expect(
      repository.applyOutcome(second, loaded, inbound, OutcomeRecord.CONFIRMED),
    ).rejects.toBeInstanceOf(EventAlreadyProcessedError);

    const reloaded = await repository.findById(id);
    expect(reloaded?.status).toBe(OrderStatus.PENDING);
    expect(reloaded?.paymentOutcome).toBe(PaymentOutcome.PENDING);
  });
});
