import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Consumer, Kafka, Producer } from 'kafkajs';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import { KAFKA_PRODUCER } from '../../src/infra/kafka/kafka.constants';
import {
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(240_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

async function waitFor(assertion: () => void, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe('Confirm Order — full write flow (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  // Same rationale as cancel-order.component.spec.ts: this service is a Kafka producer
  // only, so the test itself observes the topic to prove the event was published.
  let observerConsumer: Consumer;
  const observedMessages: Array<{ aggregateId: string }> = [];

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    kafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').start();

    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = kafkaBroker;

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
        ]),
        CqrsModule.forRoot(),
        KafkaModule,
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        ConfirmOrderService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        OrderEventsProducer,
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

    const observerKafka = new Kafka({ clientId: 'test-observer', brokers: [kafkaBroker] });
    const admin = observerKafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: ORDER_CONFIRMED_TOPIC, numPartitions: 1 }] });
    await admin.disconnect();

    observerConsumer = observerKafka.consumer({ groupId: 'test-observer-group' });
    await observerConsumer.connect();
    await observerConsumer.subscribe({ topic: ORDER_CONFIRMED_TOPIC, fromBeginning: true });
    await observerConsumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as { aggregateId: string };
        observedMessages.push({ aggregateId: event.aggregateId });
      },
    });
  });

  afterAll(async () => {
    await observerConsumer.disconnect();
    await app.close();
    await kafkaContainer.stop();
    await postgresContainer.stop();
  });

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }],
      });
    return response.body.orderId;
  }

  it('should update the order status to CONFIRMED and emit OrderConfirmed to Kafka', async () => {
    const orderId = await placeOrder();

    const response = await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ orderId, status: 'CONFIRMED' });

    const rows = await dataSource.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0].status).toBe('CONFIRMED');

    await waitFor(() => {
      const published = observedMessages.find((m) => m.aggregateId === orderId);
      expect(published).toBeDefined();
    });
  });

  it('should return 409 without touching Kafka when the order is already confirmed', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);

    // Wait for the first confirmation's message to actually arrive before asserting
    // that the second (rejected) attempt doesn't produce a new one.
    await waitFor(() => {
      expect(observedMessages.filter((m) => m.aggregateId === orderId)).toHaveLength(1);
    });

    const response = await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);

    expect(response.status).toBe(409);
    expect(observedMessages.filter((m) => m.aggregateId === orderId)).toHaveLength(1);
  });

  it('should not return 500 when the Kafka publish fails after the status update succeeds', async () => {
    const orderId = await placeOrder();
    const producer = app.get<Producer>(KAFKA_PRODUCER);
    const originalSend = producer.send.bind(producer);
    producer.send = jest.fn().mockRejectedValueOnce(new Error('simulated broker outage'));

    const response = await request(app.getHttpServer()).post(`/orders/${orderId}/confirm`);

    expect(response.status).toBe(200);

    const rows = await dataSource.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0].status).toBe('CONFIRMED');

    const deadLetterRows = await dataSource.query(
      'SELECT * FROM order_dead_letters WHERE topic = $1 ORDER BY "createdAt" DESC LIMIT 1',
      [ORDER_CONFIRMED_TOPIC],
    );
    expect(deadLetterRows.length).toBeGreaterThanOrEqual(1);

    producer.send = originalSend;
  });
});
