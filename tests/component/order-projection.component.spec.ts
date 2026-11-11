import { Test } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getConnectionToken } from '@nestjs/mongoose';
import { DataSource } from 'typeorm';
import { Connection } from 'mongoose';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Kafka, Producer } from 'kafkajs';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import { ConsumedMessageDeadLetterEntity } from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { OrdersController } from '../../src/controllers/orders.controller';
import { ReadModelModule } from '../../src/read-model/read-model.module';
import { OrderProjectionConsumer } from '../../src/infra/kafka/order-projection.consumer';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';

jest.setTimeout(300_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** The order_views document as stored (raw Mongo). */
interface RawOrderView {
  _id: string;
  status: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number; subtotal: number }> | null;
  totalAmount: number | null;
  placedAt: Date | null;
  confirmedAt: Date | null;
  appliedEventIds: string[];
}

async function waitFor<T>(probe: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await probe();
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe('Order read model projection — REST → Postgres → Kafka → MongoDB (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let mongoContainer: StartedMongoDBContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let mongo: Connection;
  let testProducer: Producer;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    [postgresContainer, kafkaContainer, mongoContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
      new MongoDBContainer('mongo:7').start(),
    ]);

    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = kafkaBroker;
    process.env.MONGO_URI = `${mongoContainer.getConnectionString()}/orders_read?directConnection=true`;
    process.env.KAFKA_PROJECTION_GROUP_ID = `projection-component-${randomUUID()}`;
    process.env.KAFKA_CONSUMER_ENABLED = 'true';
    process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS = '3';
    process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS = '10';
    process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS = '50';

    const testKafka = new Kafka({ clientId: 'test-harness', brokers: [kafkaBroker] });
    const admin = testKafka.admin();
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [ORDER_PLACED_TOPIC, ORDER_CONFIRMED_TOPIC, ORDER_CANCELLED_TOPIC].map((topic) => ({
        topic,
        numPartitions: 1,
      })),
    });
    await admin.disconnect();
    testProducer = testKafka.producer();
    await testProducer.connect();

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
        ReadModelModule,
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        ConfirmOrderService,
        CancelOrderService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ConsumedMessageDeadLetterRepository,
        OrderEventsProducer,
        OrderProjectionConsumer,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    mongo = moduleRef.get<Connection>(getConnectionToken());
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: EXISTING_CUSTOMER_ID, createdAt: new Date() });
  });

  afterAll(async () => {
    await testProducer.disconnect();
    await app.close();
    await Promise.all([kafkaContainer.stop(), postgresContainer.stop(), mongoContainer.stop()]);
    jest.restoreAllMocks();
    for (const name of [
      'MONGO_URI',
      'KAFKA_PROJECTION_GROUP_ID',
      'KAFKA_CONSUMER_ENABLED',
      'PAYMENT_CONSUMER_MAX_ATTEMPTS',
      'PAYMENT_CONSUMER_BACKOFF_INITIAL_MS',
      'PAYMENT_CONSUMER_BACKOFF_MAX_MS',
    ]) {
      delete process.env[name];
    }
  });

  async function view(orderId: string): Promise<RawOrderView | null> {
    return mongo.collection<RawOrderView>('order_views').findOne({ _id: orderId });
  }

  async function viewWithStatus(orderId: string, status: string): Promise<RawOrderView> {
    return waitFor(async () => {
      const found = await view(orderId);
      expect(found?.status).toBe(status);
      return found as RawOrderView;
    });
  }

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [
          { productId: 'p-1', quantity: 3, unitPrice: 19.99 },
          { productId: 'p-2', quantity: 1, unitPrice: 5 },
        ],
      });
    expect(response.status).toBe(201);
    return response.body.orderId;
  }

  it('should project a placed order as PENDING and then as CONFIRMED after confirmation', async () => {
    const orderId = await placeOrder();

    const pending = await viewWithStatus(orderId, 'PENDING');
    expect(pending.customerId).toBe(EXISTING_CUSTOMER_ID);
    expect(pending.items).toEqual([
      { productId: 'p-1', quantity: 3, unitPrice: 19.99, subtotal: 59.97 },
      { productId: 'p-2', quantity: 1, unitPrice: 5, subtotal: 5 },
    ]);
    expect(pending.totalAmount).toBe(64.97);
    expect(pending.placedAt).toBeInstanceOf(Date);
    expect(pending.confirmedAt).toBeNull();

    const confirm = await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);
    expect(confirm.status).toBe(200);

    const confirmed = await viewWithStatus(orderId, 'CONFIRMED');
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect(confirmed.appliedEventIds).toHaveLength(2);
    expect(confirmed.totalAmount).toBe(64.97);
  });

  it('should backfill an order whose OrderPlaced was already in Kafka, and ignore it when redelivered', async () => {
    const orderId = randomUUID();
    const message = JSON.stringify({
      eventId: randomUUID(),
      occurredAt: '2026-11-01T09:00:00.000Z',
      aggregateId: orderId,
      version: 1,
      customerId: EXISTING_CUSTOMER_ID,
      items: [{ productId: 'legacy-1', quantity: 2, unitPrice: 12.5 }],
      totalAmount: 25,
    });

    await testProducer.send({
      topic: ORDER_PLACED_TOPIC,
      messages: [{ key: orderId, value: message }],
    });

    const backfilled = await viewWithStatus(orderId, 'PENDING');
    expect(backfilled.totalAmount).toBe(25);
    expect(backfilled.placedAt).toEqual(new Date('2026-11-01T09:00:00.000Z'));

    await testProducer.send({
      topic: ORDER_PLACED_TOPIC,
      messages: [{ key: orderId, value: message }],
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(await view(orderId)).toEqual(backfilled);
  });

  it('should dead-letter a malformed order event and keep projecting the next orders', async () => {
    const marker = `not json ${randomUUID()}`;
    await testProducer.send({ topic: ORDER_PLACED_TOPIC, messages: [{ value: marker }] });

    const orderId = await placeOrder();

    await viewWithStatus(orderId, 'PENDING');
    const rows = await waitFor(async () => {
      const found = await dataSource.query(
        'SELECT topic, "failureType", attempts FROM consumed_message_dead_letters WHERE "rawValue" = $1',
        [marker],
      );
      expect(found).toHaveLength(1);
      return found;
    });
    expect(rows).toEqual([{ topic: ORDER_PLACED_TOPIC, failureType: 'MALFORMED', attempts: 1 }]);
  });
});
