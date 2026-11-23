import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import { KAFKA_PRODUCER } from '../../src/infra/kafka/kafka.constants';
import { OrderEventsProducer } from '../../src/infra/kafka/order-events.producer';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { OrdersController } from '../../src/controllers/orders.controller';
import { AuthModule } from '../../src/infra/auth/auth.module';
import { bearer, BearerHeader, withTestIdentity } from '../support/auth-testing';

jest.setTimeout(180_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UNKNOWN_ORDER_ID = '99999999-9999-4999-8999-999999999999';

describe('POST /orders/:orderId/cancel (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let mockProducer: { send: jest.Mock; connect: jest.Mock; disconnect: jest.Mock };

  const auth = withTestIdentity();
  let owner: BearerHeader;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    mockProducer = {
      send: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AuthModule,
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
        ]),
        CqrsModule.forRoot(),
        KafkaModule,
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        CancelOrderService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        OrderEventsProducer,
      ],
    })
      .overrideProvider(KAFKA_PRODUCER)
      .useValue(mockProducer)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: EXISTING_CUSTOMER_ID, createdAt: new Date() });
    owner = await auth.customerHeaders(EXISTING_CUSTOMER_ID);
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(await auth.customerHeaders(EXISTING_CUSTOMER_ID))
      .send({
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }],
      });
    return response.body.orderId;
  }

  it('should cancel a PENDING order and return its CANCELLED status', async () => {
    const orderId = await placeOrder();

    const response = await request(app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set(owner);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ orderId, status: 'CANCELLED' });

    const rows = await dataSource.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0].status).toBe('CANCELLED');
  });

  it('should return 404 when the order does not exist', async () => {
    const response = await request(app.getHttpServer())
      .post(`/orders/${UNKNOWN_ORDER_ID}/cancel`)
      .set(owner);

    expect(response.status).toBe(404);
  });

  it('should return 400 when orderId is not a valid UUID', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders/not-a-uuid/cancel')
      .set(owner);

    expect(response.status).toBe(400);
  });

  it('should return 409 when the order is already cancelled', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(owner);

    const response = await request(app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set(owner);

    expect(response.status).toBe(409);
  });

  it('should return 409 when the order is CONFIRMED (not PENDING)', async () => {
    const orderId = await placeOrder();
    await dataSource.query('UPDATE orders SET status = $1 WHERE id = $2', ['CONFIRMED', orderId]);

    const response = await request(app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set(owner);

    expect(response.status).toBe(409);
  });

  it('should cancel a PENDING order through REST whatever its outcomes, and leave the outcomes unchanged', async () => {
    const orderId = await placeOrder();
    await dataSource.query(
      `UPDATE orders SET "paymentOutcome" = 'PROCESSED', "stockOutcome" = 'PENDING' WHERE id = $1`,
      [orderId],
    );

    const response = await request(app.getHttpServer())
      .post(`/orders/${orderId}/cancel`)
      .set(owner);

    expect(response.status).toBe(200);
    const rows = await dataSource.query(
      'SELECT status, "paymentOutcome", "stockOutcome" FROM orders WHERE id = $1',
      [orderId],
    );
    expect(rows[0]).toEqual({
      status: 'CANCELLED',
      paymentOutcome: 'PROCESSED',
      stockOutcome: 'PENDING',
    });
  });

  describe('ownership and roles (US-11)', () => {
    async function statusOf(orderId: string): Promise<string> {
      const [row] = await dataSource.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      return row.status;
    }

    function cancelledEventsFor(orderId: string): number {
      return mockProducer.send.mock.calls.filter(
        ([record]: [{ topic: string; messages: { key: string }[] }]) =>
          record.topic === 'orders.order-cancelled' && record.messages[0].key === orderId,
      ).length;
    }

    it("should answer another customer's order exactly like an unknown id and change nothing", async () => {
      const orderId = await placeOrder();
      const intruder = await auth.customerHeaders(OTHER_CUSTOMER_ID);

      const notMine = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set(intruder);
      const unknown = await request(app.getHttpServer())
        .post(`/orders/${UNKNOWN_ORDER_ID}/cancel`)
        .set(intruder);

      expect(notMine.status).toBe(404);
      expect(notMine.text).toBe(unknown.text);
      expect(notMine.body).toEqual({
        statusCode: 404,
        message: 'Order not found',
        error: 'Not Found',
      });
      expect(await statusOf(orderId)).toBe('PENDING');
      expect(cancelledEventsFor(orderId)).toBe(0);
    });

    it.each([
      ['an ADMIN-only token', (): Promise<BearerHeader> => auth.adminHeaders()],
      [
        'a CUSTOMER+ADMIN token of another customer',
        (): Promise<BearerHeader> => auth.customerAdminHeaders(OTHER_CUSTOMER_ID),
      ],
    ])("should let %s cancel another customer's order", async (_label, headers) => {
      const orderId = await placeOrder();

      const response = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set(await headers());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ orderId, status: 'CANCELLED' });
      expect(cancelledEventsFor(orderId)).toBe(1);
    });

    it.each([
      ['a CUSTOMER token without a customerId', { roles: ['CUSTOMER'] }],
      ['a token with unknown roles only', { roles: ['SUPPORT'], customerId: EXISTING_CUSTOMER_ID }],
    ])('should return 403 for %s and change nothing', async (_label, claims) => {
      const orderId = await placeOrder();

      const response = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set(bearer(await auth.identity.sign(claims)));

      expect(response.status).toBe(403);
      expect(await statusOf(orderId)).toBe('PENDING');
    });
  });
});
