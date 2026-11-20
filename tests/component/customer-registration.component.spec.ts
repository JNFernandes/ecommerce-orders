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
import { Kafka, Producer } from 'kafkajs';
import { createTopicsWhenReady } from './support/kafka-testing';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import {
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import { IdentityEventsConsumer } from '../../src/infra/kafka/identity-events.consumer';
import { USER_REGISTERED_TOPIC } from '../../src/infra/kafka/user-registered-message.parser';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import {
  ConsumedMessageDeadLetterEntity,
  ConsumedMessageFailureType,
} from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { CreateCustomerService } from '../../src/services/create-customer.service';
import { OrdersController } from '../../src/controllers/orders.controller';

jest.setTimeout(300_000);

async function waitFor(assertion: () => Promise<void> | void, timeoutMs: number): Promise<void> {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('Customer registration — identity.user-registered → customers (component)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let testProducer: Producer;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    kafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').start();

    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = kafkaBroker;
    process.env.KAFKA_IDENTITY_GROUP_ID = `orders-identity-${randomUUID()}`;
    process.env.KAFKA_CONSUMER_ENABLED = 'true';
    process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS = '5';
    process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS = '10';
    process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS = '50';

    const testKafka = new Kafka({ clientId: 'test-harness', brokers: [kafkaBroker] });
    const admin = testKafka.admin();
    await admin.connect();
    await createTopicsWhenReady(admin, {
      waitForLeaders: true,
      topics: [USER_REGISTERED_TOPIC, ORDER_PLACED_TOPIC].map((topic) => ({
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
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderService,
        CreateCustomerService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ConsumedMessageDeadLetterRepository,
        OrderEventsProducer,
        IdentityEventsConsumer,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    dataSource = moduleRef.get(DataSource);

    testProducer = testKafka.producer();
    await testProducer.connect();
  });

  afterAll(async () => {
    await testProducer?.disconnect();
    await app?.close();
    await kafkaContainer?.stop();
    await postgresContainer?.stop();
    jest.restoreAllMocks();
    delete process.env.KAFKA_IDENTITY_GROUP_ID;
    delete process.env.KAFKA_CONSUMER_ENABLED;
    delete process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS;
    delete process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS;
  });

  function userRegistered(customerId: string, userId: string): string {
    return JSON.stringify({
      eventId: randomUUID(),
      aggregateId: userId,
      occurredAt: new Date().toISOString(),
      version: 1,
      customerId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
  }

  async function customerExists(id: string): Promise<boolean> {
    return dataSource.getRepository(CustomerEntity).existsBy({ id });
  }

  it('should create the customer keyed by customerId (not aggregateId), who can then place an order', async () => {
    const customerId = randomUUID();
    const userId = randomUUID();

    await testProducer.send({
      topic: USER_REGISTERED_TOPIC,
      messages: [{ key: userId, value: userRegistered(customerId, userId) }],
    });

    await waitFor(async () => {
      expect(await customerExists(customerId)).toBe(true);
    }, 120_000);
    expect(await customerExists(userId)).toBe(false);
    expect(
      await dataSource.getRepository(CustomerEntity).findOneBy({ id: customerId }),
    ).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });

    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId, items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }] });
    expect(response.status).toBe(201);
  });

  it('should keep one customer on redelivery and ignore a new eventId for an existing customer', async () => {
    const customerId = randomUUID();
    const userId = randomUUID();
    const original = userRegistered(customerId, userId);
    const repeat = JSON.stringify({
      ...(JSON.parse(original) as Record<string, unknown>),
      eventId: randomUUID(),
      name: 'Someone Else',
    });

    await testProducer.send({
      topic: USER_REGISTERED_TOPIC,
      messages: [original, original, repeat].map((value) => ({ key: userId, value })),
    });

    const processed = dataSource.getRepository(ProcessedEventEntity);
    await waitFor(async () => {
      expect(await processed.countBy({ customerId })).toBe(2);
    }, 120_000);
    expect(await dataSource.getRepository(CustomerEntity).countBy({ id: customerId })).toBe(1);
    expect(
      await dataSource.getRepository(CustomerEntity).findOneBy({ id: customerId }),
    ).toMatchObject({ name: 'Ada Lovelace' });
    expect(
      await dataSource.getRepository(ConsumedMessageDeadLetterEntity).countBy({
        topic: USER_REGISTERED_TOPIC,
        failureType: ConsumedMessageFailureType.RETRIES_EXHAUSTED,
      }),
    ).toBe(0);
  });

  it('should dead-letter malformed messages (not retryable) and still process the next valid one', async () => {
    const customerId = randomUUID();
    const userId = randomUUID();
    const withoutEmail = JSON.stringify({
      ...(JSON.parse(userRegistered(randomUUID(), userId)) as Record<string, unknown>),
      email: undefined,
    });
    const deadLetters = dataSource.getRepository(ConsumedMessageDeadLetterEntity);
    const before = await deadLetters.countBy({
      topic: USER_REGISTERED_TOPIC,
      failureType: ConsumedMessageFailureType.MALFORMED,
    });

    await testProducer.send({
      topic: USER_REGISTERED_TOPIC,
      messages: ['not json', withoutEmail, userRegistered(customerId, userId)].map((value) => ({
        key: userId,
        value,
      })),
    });

    await waitFor(async () => {
      expect(await customerExists(customerId)).toBe(true);
    }, 120_000);
    expect(
      await deadLetters.countBy({
        topic: USER_REGISTERED_TOPIC,
        failureType: ConsumedMessageFailureType.MALFORMED,
      }),
    ).toBe(before + 2);
  });
});
