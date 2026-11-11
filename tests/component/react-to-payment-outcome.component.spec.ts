import { Test } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Consumer, Kafka, Producer } from 'kafkajs';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { PaymentEventsConsumer } from '../../src/infra/kafka/payment-events.consumer';
import {
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
} from '../../src/infra/kafka/payment-message.parser';
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
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { ReactToPaymentOutcomeService } from '../../src/services/react-to-payment-outcome.service';
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(300_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

interface ObservedEvent {
  topic: string;
  aggregateId: string;
  reason?: string;
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('React to payment outcome — Kafka → Orders → Kafka (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let testProducer: Producer;
  let observerConsumer: Consumer;
  const observed: ObservedEvent[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    kafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').start();

    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = kafkaBroker;
    process.env.KAFKA_GROUP_ID = `orders-component-${randomUUID()}`;
    process.env.KAFKA_CONSUMER_ENABLED = 'true';
    process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS = '3';
    process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS = '10';
    process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS = '50';

    const testKafka = new Kafka({ clientId: 'test-harness', brokers: [kafkaBroker] });
    const admin = testKafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        PAYMENT_PROCESSED_TOPIC,
        PAYMENT_FAILED_TOPIC,
        ORDER_CONFIRMED_TOPIC,
        ORDER_CANCELLED_TOPIC,
      ].map((topic) => ({ topic, numPartitions: 1 })),
    });
    await admin.disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: postgresContainer.getHost(),
          port: postgresContainer.getPort(),
          username: postgresContainer.getUsername(),
          password: postgresContainer.getPassword(),
          database: postgresContainer.getDatabase(),
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
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: EXISTING_CUSTOMER_ID, createdAt: new Date() });

    testProducer = testKafka.producer();
    await testProducer.connect();

    observerConsumer = testKafka.consumer({ groupId: `test-observer-${randomUUID()}` });
    await observerConsumer.connect();
    await observerConsumer.subscribe({
      topics: [ORDER_CONFIRMED_TOPIC, ORDER_CANCELLED_TOPIC],
      fromBeginning: true,
    });
    await observerConsumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as {
          aggregateId: string;
          reason?: string;
        };
        observed.push({ topic, aggregateId: event.aggregateId, reason: event.reason });
      },
    });
  });

  afterAll(async () => {
    await observerConsumer.disconnect();
    await testProducer.disconnect();
    await app.close();
    await kafkaContainer.stop();
    await postgresContainer.stop();
    jest.restoreAllMocks();
    delete process.env.KAFKA_GROUP_ID;
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS;
  });

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }],
      });
    expect(response.status).toBe(201);
    return response.body.orderId;
  }

  async function orderRow(
    orderId: string,
  ): Promise<{ status: string; cancellationReason: string | null }> {
    const rows = await dataSource.query(
      'SELECT status, "cancellationReason" FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0];
  }

  async function publish(topic: string, value: string): Promise<void> {
    await testProducer.send({ topic, messages: [{ key: randomUUID(), value }] });
  }

  function eventsFor(topic: string, orderId: string): ObservedEvent[] {
    return observed.filter((e) => e.topic === topic && e.aggregateId === orderId);
  }

  function paymentProcessed(orderId: string): string {
    return JSON.stringify({
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      aggregateId: randomUUID(),
      version: 1,
      orderId,
      amount: 10,
      currency: 'USD',
      processedAt: new Date().toISOString(),
    });
  }

  it('should confirm the order and emit exactly one OrderConfirmed when payment is processed', async () => {
    const orderId = await placeOrder();

    await publish(PAYMENT_PROCESSED_TOPIC, paymentProcessed(orderId));

    await waitFor(async () => {
      expect((await orderRow(orderId)).status).toBe('CONFIRMED');
    });
    await waitFor(() => {
      expect(eventsFor(ORDER_CONFIRMED_TOPIC, orderId)).toHaveLength(1);
    });
    await sleep(1_500);
    expect(eventsFor(ORDER_CONFIRMED_TOPIC, orderId)).toHaveLength(1);
  });

  it('should cancel the order with the reason and emit exactly one OrderCancelled when payment fails', async () => {
    const orderId = await placeOrder();
    const reason = 'Amount 15000.00 USD exceeds the maximum allowed threshold of 10000.00 USD.';

    await publish(
      PAYMENT_FAILED_TOPIC,
      JSON.stringify({
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        aggregateId: randomUUID(),
        version: 1,
        orderId,
        reason,
        failedAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      expect(await orderRow(orderId)).toEqual({ status: 'CANCELLED', cancellationReason: reason });
    });
    await waitFor(() => {
      expect(eventsFor(ORDER_CANCELLED_TOPIC, orderId)).toHaveLength(1);
    });
    await sleep(1_500);
    const cancelled = eventsFor(ORDER_CANCELLED_TOPIC, orderId);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].reason).toBe(reason);
  });
});
