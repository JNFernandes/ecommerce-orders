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
import { OrdersController } from '../../src/controllers/orders.controller';
import { AuthModule } from '../../src/infra/auth/auth.module';
import { bearer, BearerHeader, withTestIdentity } from '../support/auth-testing';

jest.setTimeout(180_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const UNKNOWN_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

describe('POST /orders (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let mockProducer: { send: jest.Mock; connect: jest.Mock; disconnect: jest.Mock };
  let customer: BearerHeader;

  const auth = withTestIdentity();

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
    customer = await auth.customerHeaders(EXISTING_CUSTOMER_ID);
  });

  beforeEach(() => {
    mockProducer.send.mockClear();
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  const ITEMS = [{ productId: 'prod-001', quantity: 1, unitPrice: 1 }];

  async function countOrders(): Promise<number> {
    const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM orders');
    return count;
  }

  /** The `customerId` of the OrderPlaced event in the last producer `send`. */
  function lastPublishedCustomerId(): unknown {
    const [record] = mockProducer.send.mock.calls.at(-1) as [{ messages: { value: string }[] }];
    return (JSON.parse(record.messages[0].value) as { customerId: unknown }).customerId;
  }

  // IT-01
  it('should return 201 and orderId for a valid payload', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({ items: [{ productId: 'prod-001', quantity: 2, unitPrice: 29.99 }] });

    expect(response.status).toBe(201);
    expect(response.body.orderId).toBeDefined();
  });

  // IT-06
  it('should save the order for the token customer and publish it with that customerId', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({ items: [{ productId: 'prod-002', quantity: 3, unitPrice: 10 }] });

    const row = await dataSource.query('SELECT * FROM orders WHERE id = $1', [
      response.body.orderId,
    ]);
    expect(row).toHaveLength(1);
    expect(row[0].status).toBe('PENDING');
    expect(row[0].customerId).toBe(EXISTING_CUSTOMER_ID);
    expect(Number(row[0].totalAmount)).toBe(30);
    expect(lastPublishedCustomerId()).toBe(EXISTING_CUSTOMER_ID);
  });

  // IT-08
  it('should consolidate duplicate productId entries into one row', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({
        items: [
          { productId: 'prod-003', quantity: 2, unitPrice: 5 },
          { productId: 'prod-003', quantity: 4, unitPrice: 5 },
        ],
      });

    const items = await dataSource.query('SELECT * FROM order_items WHERE "orderId" = $1', [
      response.body.orderId,
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(6);
  });

  // IT-02 (US-11): the customer comes from the token only
  it.each([
    ['the caller', EXISTING_CUSTOMER_ID],
    ['another customer', UNKNOWN_CUSTOMER_ID],
  ])(
    'should return 400 and save or publish nothing when the body names a customerId (%s)',
    async (_label, customerId) => {
      const before = await countOrders();

      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(customer)
        .send({ customerId, items: ITEMS });

      expect(response.status).toBe(400);
      expect(await countOrders()).toBe(before);
      expect(mockProducer.send).not.toHaveBeenCalled();
    },
  );

  // IT-03
  it('should return 400 when quantity is invalid', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({ items: [{ productId: 'prod-001', quantity: 0, unitPrice: 1 }] });

    expect(response.status).toBe(400);
  });

  // IT-04
  it('should return 400 when unitPrice is invalid', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({ items: [{ productId: 'prod-001', quantity: 1, unitPrice: 0 }] });

    expect(response.status).toBe(400);
  });

  // IT-05
  it('should return 400 when items array is empty', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(customer)
      .send({ items: [] });

    expect(response.status).toBe(400);
  });

  // IT-07
  it('should return 404 when the token customer has not been created yet', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(await auth.customerHeaders(UNKNOWN_CUSTOMER_ID))
      .send({ items: ITEMS });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Customer not found');

    const rows = await dataSource.query('SELECT * FROM orders WHERE "customerId" = $1', [
      UNKNOWN_CUSTOMER_ID,
    ]);
    expect(rows).toHaveLength(0);
  });

  describe('roles (US-11)', () => {
    it('should return 403 for an ADMIN-only token and save nothing', async () => {
      const before = await countOrders();

      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(await auth.adminHeaders())
        .send({ items: ITEMS });

      expect(response.status).toBe(403);
      expect(await countOrders()).toBe(before);
    });

    it('should return 403 for a CUSTOMER token without a customerId', async () => {
      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(bearer(await auth.identity.sign({ roles: ['CUSTOMER'] })))
        .send({ items: ITEMS });

      expect(response.status).toBe(403);
    });

    it('should place the order for its own customerId with a CUSTOMER+ADMIN token', async () => {
      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(await auth.customerAdminHeaders(EXISTING_CUSTOMER_ID))
        .send({ items: ITEMS });

      expect(response.status).toBe(201);
      const [row] = await dataSource.query('SELECT "customerId" FROM orders WHERE id = $1', [
        response.body.orderId,
      ]);
      expect(row.customerId).toBe(EXISTING_CUSTOMER_ID);
    });
  });
});
