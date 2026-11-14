import { Test } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { EachMessagePayload } from 'kafkajs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import { KAFKA_CLIENT, KAFKA_PRODUCER } from '../../src/infra/kafka/kafka.constants';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { InventoryEventsConsumer } from '../../src/infra/kafka/inventory-events.consumer';
import { PaymentEventsConsumer } from '../../src/infra/kafka/payment-events.consumer';
import {
  STOCK_REJECTED_TOPIC,
  STOCK_RESERVED_TOPIC,
} from '../../src/infra/kafka/stock-message.parser';
import { PAYMENT_PROCESSED_TOPIC } from '../../src/infra/kafka/payment-message.parser';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import { ConsumedMessageDeadLetterEntity } from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { ProcessedEventRepository } from '../../src/repositories/processed-event.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { OutcomeWriteFlow } from '../../src/services/outcome-write-flow';
import { ApplyPaymentOutcomeService } from '../../src/services/apply-payment-outcome.service';
import { ApplyStockOutcomeService } from '../../src/services/apply-stock-outcome.service';
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(180_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('Inventory outcome consumer (integration, real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let inventory: InventoryEventsConsumer;
  let payments: PaymentEventsConsumer;
  const producerSend = jest.fn().mockResolvedValue(undefined);
  const commitOffsets = jest.fn().mockResolvedValue(undefined);
  let nextOffset = 0;

  beforeAll(async () => {
    process.env.KAFKA_CONSUMER_ENABLED = 'false';
    process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS = '3';
    process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS = '1';
    process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS = '5';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    const mockProducer = {
      send: producerSend,
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const mockKafka = {
      consumer: jest.fn().mockReturnValue({
        commitOffsets,
        disconnect: jest.fn().mockResolvedValue(undefined),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: container.getHost(),
          port: container.getPort(),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
          autoLoadEntities: true,
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          OrderEntity,
          OrderItemEntity,
          OrderDeadLetterEntity,
          CustomerEntity,
          ProcessedEventEntity,
          ConsumedMessageDeadLetterEntity,
        ]),
        CqrsModule.forRoot(),
        KafkaModule,
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        ConfirmOrderService,
        CancelOrderService,
        OutcomeWriteFlow,
        ApplyPaymentOutcomeService,
        ApplyStockOutcomeService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ProcessedEventRepository,
        ConsumedMessageDeadLetterRepository,
        OrderEventsProducer,
        PaymentEventsConsumer,
        InventoryEventsConsumer,
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(mockKafka)
      .overrideProvider(KAFKA_PRODUCER)
      .useValue(mockProducer)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    inventory = moduleRef.get(InventoryEventsConsumer);
    payments = moduleRef.get(PaymentEventsConsumer);
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: EXISTING_CUSTOMER_ID, createdAt: new Date() });
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
    jest.restoreAllMocks();
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS;
  });

  beforeEach(() => {
    producerSend.mockClear();
    commitOffsets.mockClear();
  });

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }],
      });
    expect(response.status).toBe(201);
    producerSend.mockClear();
    return response.body.orderId;
  }

  async function orderRow(orderId: string): Promise<{
    status: string;
    paymentOutcome: string;
    stockOutcome: string;
    cancellationReason: string | null;
  }> {
    const rows = await dataSource.query(
      'SELECT status, "paymentOutcome", "stockOutcome", "cancellationReason" FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0];
  }

  async function processedRows(
    eventId: string,
  ): Promise<Array<{ outcome: string; paymentId: string | null; reservationId: string | null }>> {
    return dataSource.query(
      'SELECT outcome, "paymentId", "reservationId" FROM processed_events WHERE "eventId" = $1',
      [eventId],
    );
  }

  async function deadLettersFor(
    eventId: string | null,
    rawValue?: string,
  ): Promise<
    Array<{ failureType: string; status: string; attempts: number; orderId: string | null }>
  > {
    return eventId === null
      ? dataSource.query(
          'SELECT "failureType", status, attempts, "orderId" FROM consumed_message_dead_letters WHERE "rawValue" = $1',
          [rawValue],
        )
      : dataSource.query(
          'SELECT "failureType", status, attempts, "orderId" FROM consumed_message_dead_letters WHERE "eventId" = $1',
          [eventId],
        );
  }

  function stockMessage(
    orderId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      orderId,
      items: [{ productId: 'prod-001', quantity: 1 }],
      reservedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function rejectedMessage(orderId: string): Record<string, unknown> {
    return stockMessage(orderId, {
      reason: 'insufficient stock',
      items: [{ productId: 'prod-001', requested: 1, available: 0 }],
      rejectedAt: new Date().toISOString(),
    });
  }

  function paymentProcessed(orderId: string): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      aggregateId: randomUUID(),
      version: 1,
      orderId,
      amount: 10,
      currency: 'USD',
      processedAt: new Date().toISOString(),
    };
  }

  function payloadFor(topic: string, value: string | Record<string, unknown>): EachMessagePayload {
    return {
      topic,
      partition: 0,
      message: {
        key: null,
        value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        timestamp: '0',
        attributes: 0,
        offset: String(nextOffset++),
        headers: {},
      },
      heartbeat: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn(),
    } as unknown as EachMessagePayload;
  }

  function sentTopics(): string[] {
    return producerSend.mock.calls.map((call) => (call[0] as { topic: string }).topic);
  }

  it('should record a reserved stock, keep the order PENDING and store the reservation id', async () => {
    const orderId = await placeOrder();
    const message = stockMessage(orderId);

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, message));

    expect(await orderRow(orderId)).toMatchObject({
      status: 'PENDING',
      paymentOutcome: 'PENDING',
      stockOutcome: 'RESERVED',
    });
    expect(await processedRows(message.eventId as string)).toEqual([
      { outcome: 'RECORDED', paymentId: null, reservationId: message.aggregateId },
    ]);
    expect(producerSend).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('should confirm once the payment is processed after the stock was reserved', async () => {
    const orderId = await placeOrder();
    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, stockMessage(orderId)));

    await payments.handleMessage(payloadFor(PAYMENT_PROCESSED_TOPIC, paymentProcessed(orderId)));

    expect((await orderRow(orderId)).status).toBe('CONFIRMED');
    expect(sentTopics()).toEqual([ORDER_CONFIRMED_TOPIC]);
  });

  it('should confirm once the stock is reserved after the payment was processed', async () => {
    const orderId = await placeOrder();
    await payments.handleMessage(payloadFor(PAYMENT_PROCESSED_TOPIC, paymentProcessed(orderId)));

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, stockMessage(orderId)));

    expect((await orderRow(orderId)).status).toBe('CONFIRMED');
    expect(sentTopics()).toEqual([ORDER_CONFIRMED_TOPIC]);
  });

  it('should cancel with a "stock rejected" reason and publish it', async () => {
    const orderId = await placeOrder();
    const message = rejectedMessage(orderId);

    await inventory.handleMessage(payloadFor(STOCK_REJECTED_TOPIC, message));

    expect(await orderRow(orderId)).toMatchObject({
      status: 'CANCELLED',
      stockOutcome: 'REJECTED',
      cancellationReason: 'stock rejected: insufficient stock',
    });
    expect(await processedRows(message.eventId as string)).toEqual([
      expect.objectContaining({ outcome: 'CANCELLED' }),
    ]);
    expect(sentTopics()).toEqual([ORDER_CANCELLED_TOPIC]);
    const sent = producerSend.mock.calls[0][0] as { messages: Array<{ value: string }> };
    expect(JSON.parse(sent.messages[0].value).reason).toBe('stock rejected: insufficient stock');
  });

  it('should ignore a rejection after a reserved stock as IGNORED_CONFLICT (first stock outcome wins)', async () => {
    const orderId = await placeOrder();
    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, stockMessage(orderId)));
    const rejection = rejectedMessage(orderId);

    await inventory.handleMessage(payloadFor(STOCK_REJECTED_TOPIC, rejection));

    expect(await orderRow(orderId)).toMatchObject({ status: 'PENDING', stockOutcome: 'RESERVED' });
    expect(await processedRows(rejection.eventId as string)).toEqual([
      expect.objectContaining({ outcome: 'IGNORED_CONFLICT' }),
    ]);
    expect(producerSend).not.toHaveBeenCalled();
  });

  it('should change the order once when the same stock message is delivered twice', async () => {
    const orderId = await placeOrder();
    const message = stockMessage(orderId);

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, message));
    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, message));

    expect((await orderRow(orderId)).stockOutcome).toBe('RESERVED');
    expect(await processedRows(message.eventId as string)).toHaveLength(1);
    expect(commitOffsets).toHaveBeenCalledTimes(2);
  });

  it('should dead-letter a malformed stock message as EXHAUSTED and commit', async () => {
    const raw = JSON.stringify(stockMessage('abc'));

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, raw));

    expect(await deadLettersFor(null, raw)).toEqual([
      { failureType: 'MALFORMED', status: 'EXHAUSTED', attempts: 1, orderId: null },
    ]);
    expect(commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('should retry an unknown orderId, then dead-letter it as PENDING_RETRY and commit', async () => {
    const unknownOrderId = randomUUID();
    const message = stockMessage(unknownOrderId);

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, message));

    expect(await deadLettersFor(message.eventId as string)).toEqual([
      {
        failureType: 'RETRIES_EXHAUSTED',
        status: 'PENDING_RETRY',
        attempts: 3,
        orderId: unknownOrderId,
      },
    ]);
    expect(await processedRows(message.eventId as string)).toEqual([]);
    expect(commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('should never use the reservation id (aggregateId) as the order id', async () => {
    const existingOrderId = await placeOrder();
    const message = stockMessage(randomUUID(), { aggregateId: existingOrderId });

    await inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, message));

    expect((await orderRow(existingOrderId)).stockOutcome).toBe('PENDING');
    expect(await deadLettersFor(message.eventId as string)).toEqual([
      expect.objectContaining({ failureType: 'RETRIES_EXHAUSTED' }),
    ]);
  });

  it('should confirm exactly once when the payment and the stock outcomes are processed at the same time', async () => {
    for (let round = 0; round < 5; round += 1) {
      producerSend.mockClear();
      const orderId = await placeOrder();

      await Promise.all([
        payments.handleMessage(payloadFor(PAYMENT_PROCESSED_TOPIC, paymentProcessed(orderId))),
        inventory.handleMessage(payloadFor(STOCK_RESERVED_TOPIC, stockMessage(orderId))),
      ]);

      expect(await orderRow(orderId)).toMatchObject({
        status: 'CONFIRMED',
        paymentOutcome: 'PROCESSED',
        stockOutcome: 'RESERVED',
      });
      expect(sentTopics()).toEqual([ORDER_CONFIRMED_TOPIC]);
      expect(await deadLettersForOrder(orderId)).toEqual([]);
    }
  });

  async function deadLettersForOrder(orderId: string): Promise<unknown[]> {
    return dataSource.query('SELECT 1 FROM consumed_message_dead_letters WHERE "orderId" = $1', [
      orderId,
    ]);
  }
});
