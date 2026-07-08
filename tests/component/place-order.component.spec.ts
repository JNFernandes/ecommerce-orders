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
  ORDER_PLACED_TOPIC,
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
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(240_000);

const EXISTING_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const UNKNOWN_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

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

describe('Place Order — full write flow (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  // This service is a Kafka producer only (no consumer in-repo — the read side is a
  // separate future service). To verify CT-01 ("OrderPlaced emitted to Kafka") without
  // that consumer, the test itself subscribes a throwaway consumer to observe the topic.
  let observerConsumer: Consumer;
  const observedMessages: Array<{ aggregateId: string; totalAmount: number }> = [];

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
    await admin.createTopics({ topics: [{ topic: ORDER_PLACED_TOPIC, numPartitions: 1 }] });
    await admin.disconnect();

    observerConsumer = observerKafka.consumer({ groupId: 'test-observer-group' });
    await observerConsumer.connect();
    await observerConsumer.subscribe({ topic: ORDER_PLACED_TOPIC, fromBeginning: true });
    await observerConsumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as {
          aggregateId: string;
          totalAmount: number;
        };
        observedMessages.push({ aggregateId: event.aggregateId, totalAmount: event.totalAmount });
      },
    });
  });

  afterAll(async () => {
    await observerConsumer.disconnect();
    await app.close();
    await kafkaContainer.stop();
    await postgresContainer.stop();
  });

  // CT-01
  it('should save to DB and emit OrderPlaced to Kafka', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 2, unitPrice: 29.99 }],
      });

    expect(response.status).toBe(201);
    const { orderId } = response.body;

    const orderRows = await dataSource.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    expect(orderRows).toHaveLength(1);

    await waitFor(() => {
      const published = observedMessages.find((m) => m.aggregateId === orderId);
      expect(published).toBeDefined();
      expect(published?.totalAmount).toBeCloseTo(59.98, 2);
    });
  });

  // CT-04
  it('should reject an unknown customerId before any DB save or Kafka publish', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: UNKNOWN_CUSTOMER_ID,
        items: [{ productId: 'prod-001', quantity: 1, unitPrice: 1 }],
      });

    expect(response.status).toBe(404);

    const orderRows = await dataSource.query('SELECT * FROM orders WHERE "customerId" = $1', [
      UNKNOWN_CUSTOMER_ID,
    ]);
    expect(orderRows).toHaveLength(0);
  });

  // CT-02
  it('should not return 500 to the client when the Kafka publish fails after a successful DB save', async () => {
    const producer = app.get<Producer>(KAFKA_PRODUCER);
    const originalSend = producer.send.bind(producer);
    producer.send = jest.fn().mockRejectedValueOnce(new Error('simulated broker outage'));

    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerId: EXISTING_CUSTOMER_ID,
        items: [{ productId: 'prod-999', quantity: 1, unitPrice: 5 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.orderId).toBeDefined();

    const deadLetterRows = await dataSource.query(
      'SELECT * FROM order_dead_letters WHERE "eventId" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1',
    );
    expect(deadLetterRows.length).toBeGreaterThanOrEqual(1);

    producer.send = originalSend;
  });
});
