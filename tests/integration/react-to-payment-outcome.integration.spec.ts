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
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { PaymentEventsConsumer } from '../../src/infra/kafka/payment-events.consumer';
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
import { OrderStatusChangedConcurrentlyError } from '../../src/repositories/errors/order-status-changed-concurrently.error';
import { ProcessedEventOutcome } from '../../src/infra/database/entities/processed-event.entity';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { ReactToPaymentOutcomeService } from '../../src/services/react-to-payment-outcome.service';
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(180_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('Payment outcome consumer (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let consumer: PaymentEventsConsumer;
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
        ReactToPaymentOutcomeService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ProcessedEventRepository,
        OrderEventsProducer,
        PaymentEventsConsumer,
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
    consumer = moduleRef.get(PaymentEventsConsumer);
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
    producerSend.mockClear();
    return response.body.orderId;
  }

  async function setStatus(orderId: string, status: string): Promise<void> {
    await dataSource.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, status]);
  }

  async function statusOf(orderId: string): Promise<string> {
    const rows = await dataSource.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    return rows[0].status;
  }

  async function processedRows(eventId: string): Promise<Array<{ outcome: string }>> {
    return dataSource.query('SELECT outcome FROM processed_events WHERE "eventId" = $1', [eventId]);
  }

  function processedMessage(orderId: string, eventId = randomUUID()): Record<string, unknown> {
    return {
      eventId,
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
    const offset = String(nextOffset++);
    return {
      topic,
      partition: 0,
      message: {
        key: null,
        value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        timestamp: '0',
        attributes: 0,
        offset,
        headers: {},
      },
      heartbeat: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn(),
    } as unknown as EachMessagePayload;
  }

  function sentTopics(): string[] {
    return producerSend.mock.calls.map((call) => (call[0] as { topic: string }).topic);
  }

  describe('payments.payment-processed', () => {
    it('should confirm a PENDING order, record CONFIRMED, publish once and commit', async () => {
      const orderId = await placeOrder();
      const message = processedMessage(orderId);
      const payload = payloadFor(PAYMENT_PROCESSED_TOPIC, message);

      await consumer.handleMessage(payload);

      expect(await statusOf(orderId)).toBe('CONFIRMED');
      expect(await processedRows(message.eventId as string)).toEqual([{ outcome: 'CONFIRMED' }]);
      expect(sentTopics()).toEqual([ORDER_CONFIRMED_TOPIC]);
      expect(commitOffsets).toHaveBeenCalledWith([
        {
          topic: PAYMENT_PROCESSED_TOPIC,
          partition: 0,
          offset: String(Number(payload.message.offset) + 1),
        },
      ]);
    });

    it('should leave a CANCELLED order unchanged and record IGNORED_CONFLICT', async () => {
      const orderId = await placeOrder();
      await setStatus(orderId, 'CANCELLED');
      const message = processedMessage(orderId);

      await consumer.handleMessage(payloadFor(PAYMENT_PROCESSED_TOPIC, message));

      expect(await statusOf(orderId)).toBe('CANCELLED');
      expect(await processedRows(message.eventId as string)).toEqual([
        { outcome: 'IGNORED_CONFLICT' },
      ]);
      expect(producerSend).not.toHaveBeenCalled();
      expect(commitOffsets).toHaveBeenCalledTimes(1);
    });

    it('should leave a CONFIRMED order unchanged and record IGNORED_ALREADY_CONFIRMED', async () => {
      const orderId = await placeOrder();
      await setStatus(orderId, 'CONFIRMED');
      const message = processedMessage(orderId);

      await consumer.handleMessage(payloadFor(PAYMENT_PROCESSED_TOPIC, message));

      expect(await statusOf(orderId)).toBe('CONFIRMED');
      expect(await processedRows(message.eventId as string)).toEqual([
        { outcome: 'IGNORED_ALREADY_CONFIRMED' },
      ]);
      expect(producerSend).not.toHaveBeenCalled();
    });
  });

  describe('OrderRepository.applyInboundStatusChange', () => {
    it('should not overwrite an order whose status changed concurrently, and roll back', async () => {
      const orderId = await placeOrder();
      const orderRepository = app.get(OrderRepository);
      const stale = await orderRepository.findById(orderId);
      await setStatus(orderId, 'CANCELLED');
      stale!.confirm();
      const eventId = randomUUID();

      await expect(
        orderRepository.applyInboundStatusChange(
          stale!,
          { eventId, topic: PAYMENT_PROCESSED_TOPIC, orderId, paymentId: randomUUID() },
          ProcessedEventOutcome.CONFIRMED,
        ),
      ).rejects.toThrow(OrderStatusChangedConcurrentlyError);

      expect(await statusOf(orderId)).toBe('CANCELLED');
      expect(await processedRows(eventId)).toEqual([]);
    });
  });
});
