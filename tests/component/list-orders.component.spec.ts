import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Kafka } from 'kafkajs';
import { createTopicsWhenReady } from './support/kafka-testing';
import configuration from '../../src/config/configuration';
import { configureApp } from '../../src/app.setup';
import { buildGraphqlOptions } from '../../src/graphql/graphql.config';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { OrderProjectionConsumer } from '../../src/infra/kafka/order-projection.consumer';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import { ConsumedMessageDeadLetterEntity } from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { ListOrdersService } from '../../src/services/list-orders.service';
import { GetOrderService } from '../../src/services/get-order.service';
import { OrdersController } from '../../src/controllers/orders.controller';
import { OrdersResolver } from '../../src/controllers/orders.resolver';
import { ReadModelModule } from '../../src/read-model/read-model.module';

jest.setTimeout(300_000);

const CUSTOMER_A = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CUSTOMER_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

interface ListedOrder {
  orderId: string;
  customerId: string;
  status: string;
  totalAmount: number | null;
  placedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  items: Array<{ productId: string; quantity: number; subtotal: number }> | null;
}

interface OrdersPage {
  items: ListedOrder[];
  totalCount: number;
  hasNextPage: boolean;
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

describe('List orders — REST → Postgres → Kafka → projection → MongoDB → GraphQL (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let mongoContainer: StartedMongoDBContainer;
  let app: INestApplication;

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
    process.env.KAFKA_PROJECTION_GROUP_ID = `list-orders-component-${randomUUID()}`;
    process.env.KAFKA_CONSUMER_ENABLED = 'true';

    const admin = new Kafka({ clientId: 'test-harness', brokers: [kafkaBroker] }).admin();
    await admin.connect();
    await createTopicsWhenReady(admin, {
      waitForLeaders: true,
      topics: [ORDER_PLACED_TOPIC, ORDER_CONFIRMED_TOPIC, ORDER_CANCELLED_TOPIC].map((topic) => ({
        topic,
        numPartitions: 1,
      })),
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
        ReadModelModule,
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
          driver: ApolloDriver,
          inject: [ConfigService],
          useFactory: buildGraphqlOptions,
        }),
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        ConfirmOrderService,
        CancelOrderService,
        ListOrdersService,
        GetOrderService,
        OrdersResolver,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ConsumedMessageDeadLetterRepository,
        OrderEventsProducer,
        OrderProjectionConsumer,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    await moduleRef
      .get(DataSource)
      .getRepository(CustomerEntity)
      .insert([
        { id: CUSTOMER_A, createdAt: new Date() },
        { id: CUSTOMER_B, createdAt: new Date() },
      ]);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([kafkaContainer.stop(), postgresContainer.stop(), mongoContainer.stop()]);
    jest.restoreAllMocks();
    for (const name of ['MONGO_URI', 'KAFKA_PROJECTION_GROUP_ID', 'KAFKA_CONSUMER_ENABLED']) {
      delete process.env[name];
    }
  });

  async function placeOrder(customerId: string, unitPrice: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId, items: [{ productId: 'p-1', quantity: 2, unitPrice }] });
    expect(response.status).toBe(201);
    return response.body.orderId;
  }

  async function listOrders(args = 'limit: 10'): Promise<OrdersPage> {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `{ orders(${args}) { totalCount hasNextPage items {
          orderId customerId status totalAmount placedAt confirmedAt cancelledAt
          items { productId quantity subtotal } } } }`,
      });
    expect(response.body.errors).toBeUndefined();
    return response.body.data.orders as OrdersPage;
  }

  it('should list placed orders newest first, then reflect a confirmation', async () => {
    const first = await placeOrder(CUSTOMER_A, 10);
    // Two orders placed in the same millisecond tie on placedAt (then sort by orderId, which is
    // random); keep their placement times distinct so "newest first" is deterministic here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await placeOrder(CUSTOMER_A, 20);

    const page = await waitFor(async () => {
      const listed = await listOrders();
      expect(listed.items.map((o) => o.orderId)).toEqual(expect.arrayContaining([first, second]));
      return listed;
    });
    const ids = page.items.map((o) => o.orderId);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    const placed = page.items.find((o) => o.orderId === second) as ListedOrder;
    expect(placed).toMatchObject({
      customerId: CUSTOMER_A,
      status: 'PENDING',
      totalAmount: 40,
      items: [{ productId: 'p-1', quantity: 2, subtotal: 40 }],
    });
    expect(placed.placedAt).toEqual(expect.any(String));

    const confirm = await request(app.getHttpServer()).post(`/orders/${first}/confirm`);
    expect(confirm.status).toBe(200);

    await waitFor(async () => {
      const listed = await listOrders();
      const confirmed = listed.items.find((o) => o.orderId === first);
      expect(confirmed?.status).toBe('CONFIRMED');
      expect(confirmed?.confirmedAt).toEqual(expect.any(String));
    });
  });

  it('should filter the listed orders by customer and by status', async () => {
    const ofB = await placeOrder(CUSTOMER_B, 5);
    const toCancel = await placeOrder(CUSTOMER_A, 7);
    const cancel = await request(app.getHttpServer()).post(`/orders/${toCancel}/cancel`);
    expect(cancel.status).toBe(200);

    await waitFor(async () => {
      const byCustomer = await listOrders(`customerId: "${CUSTOMER_B}"`);
      expect(byCustomer.items.map((o) => o.orderId)).toEqual([ofB]);
      expect(byCustomer.totalCount).toBe(1);
    });
    await waitFor(async () => {
      const cancelled = await listOrders('status: CANCELLED');
      expect(cancelled.items.map((o) => o.orderId)).toEqual([toCancel]);
      expect(cancelled.totalCount).toBe(1);
      expect(cancelled.items[0].cancelledAt).toEqual(expect.any(String));
    });
  });

  async function getOrder(orderId: string): Promise<ListedOrder | null> {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `query ($id: ID!) { order(orderId: $id) {
          orderId customerId status totalAmount placedAt confirmedAt cancelledAt
          items { productId quantity subtotal } } }`,
        variables: { id: orderId },
      });
    expect(response.body.errors).toBeUndefined();
    return response.body.data.order as ListedOrder | null;
  }

  it('should fetch a placed order by id, then show its confirmation', async () => {
    const orderId = await placeOrder(CUSTOMER_A, 12.5);

    const placed = await waitFor(async () => {
      const found = await getOrder(orderId);
      expect(found?.status).toBe('PENDING');
      return found as ListedOrder;
    });
    expect(placed).toMatchObject({
      orderId,
      customerId: CUSTOMER_A,
      totalAmount: 25,
      items: [{ productId: 'p-1', quantity: 2, subtotal: 25 }],
    });

    const confirm = await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);
    expect(confirm.status).toBe(200);

    await waitFor(async () => {
      const found = await getOrder(orderId);
      expect(found?.status).toBe('CONFIRMED');
      expect(found?.confirmedAt).toEqual(expect.any(String));
    });
  });

  it('should return null for an order id that does not exist', async () => {
    expect(await getOrder(randomUUID())).toBeNull();
  });
});
