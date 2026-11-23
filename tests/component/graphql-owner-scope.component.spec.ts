import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { graphqlModule } from '../../src/graphql/graphql.config';
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
import { AuthModule } from '../../src/infra/auth/auth.module';
import { BearerHeader, bearer, withTestIdentity } from '../support/auth-testing';

jest.setTimeout(300_000);

const CUSTOMER_A = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CUSTOMER_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
/** A registered customer who never places an order. */
const CUSTOMER_C = '9b2e7c1a-4d3f-4e8a-9c6b-1f0a2d3e4b5c';

const LOGGER_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

const ORDER_QUERY = `query ($id: ID!) { order(orderId: $id) { orderId customerId status } }`;

interface GqlError {
  message: string;
  extensions?: Record<string, unknown>;
}

interface GqlBody<T> {
  data?: T | null;
  errors?: GqlError[];
}

interface ScopedOrder {
  orderId: string;
  customerId: string;
  status: string;
}

interface OrdersPage {
  items: ScopedOrder[];
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

describe('GraphQL owner scoping — REST → Kafka → projection → MongoDB → GraphQL (component, US-12)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let mongoContainer: StartedMongoDBContainer;
  let app: INestApplication;

  const auth = withTestIdentity();

  /** Orders placed for each customer, oldest first. */
  const ordersOfA: string[] = [];
  const ordersOfB: string[] = [];
  /** The order of A that is cancelled before the tests run. */
  let cancelledOfA = '';
  /** Everything logged through Nest's Logger while the suite runs. */
  const captured: string[] = [];

  async function placeOrder(customerId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(await auth.customerHeaders(customerId))
      .send({ items: [{ productId: 'p-1', quantity: 1, unitPrice: 10 }] });
    expect(response.status).toBe(201);
    // Distinct placement times keep "newest first" deterministic.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response.body.orderId;
  }

  async function gql<T>(
    headers: BearerHeader | Record<string, never>,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; text: string; body: GqlBody<T> }> {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .set(headers)
      .send({ query, variables });
    return { status: response.status, text: response.text, body: response.body as GqlBody<T> };
  }

  async function listAs(headers: BearerHeader, args = 'limit: 100'): Promise<OrdersPage> {
    const { body } = await gql<{ orders: OrdersPage }>(
      headers,
      `{ orders(${args}) { totalCount hasNextPage items { orderId customerId status } } }`,
    );
    expect(body.errors).toBeUndefined();
    return (body.data as { orders: OrdersPage }).orders;
  }

  beforeAll(async () => {
    // Captured (and silenced) so US4 can check that no token reaches the logs (SC-006).
    for (const method of LOGGER_METHODS) {
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      });
    }

    [postgresContainer, kafkaContainer, mongoContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
      new MongoDBContainer('mongo:7').start(),
    ]);

    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = kafkaBroker;
    process.env.MONGO_URI = `${mongoContainer.getConnectionString()}/orders_read?directConnection=true`;
    process.env.KAFKA_PROJECTION_GROUP_ID = `owner-scope-component-${randomUUID()}`;
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
        AuthModule,
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
        graphqlModule(),
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
      .insert([CUSTOMER_A, CUSTOMER_B, CUSTOMER_C].map((id) => ({ id, createdAt: new Date() })));

    // A: three orders (the oldest cancelled); B: two orders. Interleaved on purpose.
    ordersOfA.push(await placeOrder(CUSTOMER_A));
    ordersOfB.push(await placeOrder(CUSTOMER_B));
    ordersOfA.push(await placeOrder(CUSTOMER_A));
    ordersOfB.push(await placeOrder(CUSTOMER_B));
    ordersOfA.push(await placeOrder(CUSTOMER_A));
    cancelledOfA = ordersOfA[0];
    const cancel = await request(app.getHttpServer())
      .post(`/orders/${cancelledOfA}/cancel`)
      .set(await auth.adminHeaders());
    expect(cancel.status).toBe(200);

    // Wait until every order is projected, including the cancellation.
    await waitFor(async () => {
      const all = await listAs(await auth.adminHeaders());
      expect(all.totalCount).toBe(5);
      expect(all.items.find((o) => o.orderId === cancelledOfA)?.status).toBe('CANCELLED');
    });
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([kafkaContainer.stop(), postgresContainer.stop(), mongoContainer.stop()]);
    jest.restoreAllMocks();
    for (const name of ['MONGO_URI', 'KAFKA_PROJECTION_GROUP_ID', 'KAFKA_CONSUMER_ENABLED']) {
      delete process.env[name];
    }
  });

  describe('US1: a customer lists only their own orders', () => {
    it("should list only A's orders, newest first, with totals over A's orders only", async () => {
      const page = await listAs(await auth.customerHeaders(CUSTOMER_A));

      expect(page.items.map((o) => o.orderId)).toEqual([...ordersOfA].reverse());
      expect(page.items.every((o) => o.customerId === CUSTOMER_A)).toBe(true);
      expect(page.totalCount).toBe(3);
      expect(page.hasNextPage).toBe(false);
    });

    it("should apply a status filter inside A's orders", async () => {
      const pending = await listAs(await auth.customerHeaders(CUSTOMER_A), 'status: PENDING');
      const cancelled = await listAs(await auth.customerHeaders(CUSTOMER_A), 'status: CANCELLED');

      expect(pending.items.map((o) => o.orderId)).toEqual([ordersOfA[2], ordersOfA[1]]);
      expect(pending.totalCount).toBe(2);
      expect(cancelled.items.map((o) => o.orderId)).toEqual([cancelledOfA]);
      expect(cancelled.totalCount).toBe(1);
    });

    it("should page through A's orders with hasNextPage computed over A's orders only", async () => {
      const headers = await auth.customerHeaders(CUSTOMER_A);

      const first = await listAs(headers, 'limit: 2, offset: 0');
      const second = await listAs(headers, 'limit: 2, offset: 2');

      expect(first.totalCount).toBe(3);
      expect(first.hasNextPage).toBe(true);
      expect(second.hasNextPage).toBe(false);
      expect([...first.items, ...second.items].map((o) => o.orderId)).toEqual(
        [...ordersOfA].reverse(),
      );
    });

    it("should treat a customerId filter on A's own id like no filter", async () => {
      const headers = await auth.customerHeaders(CUSTOMER_A);

      expect(await listAs(headers, `limit: 100, customerId: "${CUSTOMER_A}"`)).toEqual(
        await listAs(headers),
      );
    });

    it("should answer A filtering by B's id with an empty page and no error", async () => {
      const { body } = await gql<{ orders: OrdersPage }>(
        await auth.customerHeaders(CUSTOMER_A),
        `{ orders(customerId: "${CUSTOMER_B}") { totalCount hasNextPage items { orderId } } }`,
      );

      expect(body).toEqual({
        data: { orders: { totalCount: 0, hasNextPage: false, items: [] } },
      });
    });

    it.each([
      ['a status', 'status: PENDING'],
      ['paging', 'limit: 1, offset: 1'],
      ['a status and paging', 'status: PENDING, limit: 1, offset: 0'],
    ])("should keep B's id empty for A when combined with %s", async (_label, extra) => {
      const page = await listAs(
        await auth.customerHeaders(CUSTOMER_A),
        `customerId: "${CUSTOMER_B}", ${extra}`,
      );

      expect(page).toEqual({ items: [], totalCount: 0, hasNextPage: false });
    });

    it('should give a customer with no orders an empty page', async () => {
      expect(await listAs(await auth.customerHeaders(CUSTOMER_C))).toEqual({
        items: [],
        totalCount: 0,
        hasNextPage: false,
      });
    });

    it("should return an empty page with A's totalCount for an offset past the end", async () => {
      const page = await listAs(await auth.customerHeaders(CUSTOMER_A), 'limit: 10, offset: 10');

      expect(page).toEqual({ items: [], totalCount: 3, hasNextPage: false });
    });
  });

  describe('US2: a customer can only open their own order', () => {
    it('should return A their own order', async () => {
      const { body } = await gql<{ order: ScopedOrder | null }>(
        await auth.customerHeaders(CUSTOMER_A),
        ORDER_QUERY,
        { id: ordersOfA[1] },
      );

      expect(body).toEqual({
        data: { order: { orderId: ordersOfA[1], customerId: CUSTOMER_A, status: 'PENDING' } },
      });
    });

    it("should answer A asking for B's order with null and no error", async () => {
      const { body } = await gql<{ order: ScopedOrder | null }>(
        await auth.customerHeaders(CUSTOMER_A),
        ORDER_QUERY,
        { id: ordersOfB[0] },
      );

      expect(body).toEqual({ data: { order: null } });
    });

    it("should make B's order and an unknown id byte-identical for A (no existence leak)", async () => {
      const headers = await auth.customerHeaders(CUSTOMER_A);

      const foreign = await gql(headers, ORDER_QUERY, { id: ordersOfB[1] });
      const unknown = await gql(headers, ORDER_QUERY, { id: randomUUID() });

      expect(foreign.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(foreign.text.trimEnd()).toBe('{"data":{"order":null}}');
      expect(unknown.text).toBe(foreign.text);
    });

    it("should find A's own order by an upper-case id too", async () => {
      const { body } = await gql<{ order: ScopedOrder | null }>(
        await auth.customerHeaders(CUSTOMER_A),
        ORDER_QUERY,
        { id: ordersOfA[0].toUpperCase() },
      );

      expect(body.data?.order?.orderId).toBe(ordersOfA[0]);
    });
  });

  describe('US3: an administrator sees all orders', () => {
    it('should list every order to an admin', async () => {
      const page = await listAs(await auth.adminHeaders());

      expect(page.totalCount).toBe(5);
      expect(page.items.map((o) => o.orderId).sort()).toEqual([...ordersOfA, ...ordersOfB].sort());
    });

    it("should give an admin filtering by A only A's orders", async () => {
      const page = await listAs(
        await auth.adminHeaders(),
        `limit: 100, customerId: "${CUSTOMER_A}"`,
      );

      expect(page.items.map((o) => o.orderId)).toEqual([...ordersOfA].reverse());
      expect(page.totalCount).toBe(3);
    });

    it("should let an admin open B's order", async () => {
      const { body } = await gql<{ order: ScopedOrder | null }>(
        await auth.adminHeaders(),
        ORDER_QUERY,
        { id: ordersOfB[0] },
      );

      expect(body.errors).toBeUndefined();
      expect(body.data?.order?.customerId).toBe(CUSTOMER_B);
    });

    it('should treat an admin token that also carries a customerId as an admin', async () => {
      const headers = await auth.customerAdminHeaders(CUSTOMER_A);

      const page = await listAs(headers);
      const { body } = await gql<{ order: ScopedOrder | null }>(headers, ORDER_QUERY, {
        id: ordersOfB[1],
      });

      expect(page.totalCount).toBe(5);
      expect(body.data?.order?.orderId).toBe(ordersOfB[1]);
    });
  });

  describe('US4: a caller without an owner or ADMIN is refused', () => {
    /** Tokens sent in this block, looked for in the logs and bodies at the end (SC-006). */
    const tokens: string[] = [];
    const bodies: string[] = [];

    async function as(token: string): Promise<BearerHeader> {
      tokens.push(token);
      return bearer(token);
    }

    async function expectRefused(
      headers: BearerHeader | Record<string, never>,
      code: string,
    ): Promise<void> {
      // `orders` is non-null, so a refused field nulls the whole `data`; `order` is nullable, so a
      // refused field comes back `{ order: null }`. Without a token there is no data at all.
      const cases = [
        ['{ orders { totalCount items { orderId } } }', undefined, null],
        [ORDER_QUERY, { id: ordersOfA[0] }, code === 'FORBIDDEN' ? { order: null } : null],
      ] as const;
      for (const [query, variables, data] of cases) {
        const response = await gql(headers, query, variables);
        bodies.push(response.text);
        expect(response.status).toBe(200);
        expect(response.body.data ?? null).toEqual(data);
        expect(response.body.errors?.map((e) => e.extensions?.code)).toEqual([code]);
      }
    }

    it('should answer FORBIDDEN to a CUSTOMER token without a customerId', async () => {
      await expectRefused(await as(await auth.identity.sign({ roles: ['CUSTOMER'] })), 'FORBIDDEN');
    });

    it('should answer FORBIDDEN to a token without roles', async () => {
      await expectRefused(await as(await auth.identity.sign({ roles: [] })), 'FORBIDDEN');
    });

    it('should answer UNAUTHENTICATED (HTTP 200, no data) without a token', async () => {
      await expectRefused({}, 'UNAUTHENTICATED');
    });

    it('should still answer BAD_USER_INPUT to a customer sending invalid arguments', async () => {
      const headers = await as(await auth.identity.customerToken(CUSTOMER_A));

      const list = await gql(headers, '{ orders(limit: 0) { totalCount } }');
      const one = await gql(headers, ORDER_QUERY, { id: 'not-a-uuid' });
      bodies.push(list.text, one.text);

      expect(list.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(one.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('should never write a token to the logs or a response body', () => {
      expect(tokens.length).toBeGreaterThanOrEqual(3);
      const output = [...captured, ...bodies].join('\n');
      for (const token of tokens) {
        expect(output).not.toContain(token);
        expect(output).not.toContain(token.slice(0, 20));
      }
    });
  });
});
