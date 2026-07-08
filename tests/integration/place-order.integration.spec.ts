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

jest.setTimeout(180_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const UNKNOWN_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

describe('POST /orders (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    const mockProducer = {
      send: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
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
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  // IT-01
  it('should return 201 and orderId for a valid payload', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 2, unitPrice: 29.99 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.orderId).toBeDefined();
  });

  // IT-06
  it('should save the order correctly to the write database', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-002', quantity: 3, unitPrice: 10 }],
      });

    const row = await dataSource.query('SELECT * FROM orders WHERE id = $1', [
      response.body.orderId,
    ]);
    expect(row).toHaveLength(1);
    expect(row[0].status).toBe('PENDING');
    expect(Number(row[0].totalAmount)).toBe(30);
  });

  // IT-08
  it('should consolidate duplicate productId entries into one row', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
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

  // IT-02
  it('should return 400 when customerId is missing', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ items: [{ productId: 'prod-001', quantity: 1, unitPrice: 1 }] });

    expect(response.status).toBe(400);
  });

  // IT-03
  it('should return 400 when quantity is invalid', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 0, unitPrice: 1 }],
      });

    expect(response.status).toBe(400);
  });

  // IT-04
  it('should return 400 when unitPrice is invalid', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 0 }],
      });

    expect(response.status).toBe(400);
  });

  // IT-05
  it('should return 400 when items array is empty', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: EXISTING_CUSTOMER_ID, items: [] });

    expect(response.status).toBe(400);
  });

  // IT-07
  it('should return 404 when customerId does not correspond to an existing customer', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: UNKNOWN_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 1 }],
      });

    expect(response.status).toBe(404);

    const rows = await dataSource.query('SELECT * FROM orders WHERE "customerId" = $1', [
      UNKNOWN_CUSTOMER_ID,
    ]);
    expect(rows).toHaveLength(0);
  });
});
