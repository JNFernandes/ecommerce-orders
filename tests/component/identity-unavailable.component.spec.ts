import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Kafka, Producer } from 'kafkajs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { createTopicsWhenReady } from './support/kafka-testing';
import { configureApp } from '../../src/app.setup';
import { setupSwagger } from '../../src/app.swagger';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
} from '../../src/infra/kafka/order-events.producer';
import {
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
} from '../../src/infra/kafka/payment-message.parser';
import {
  STOCK_REJECTED_TOPIC,
  STOCK_RESERVED_TOPIC,
} from '../../src/infra/kafka/stock-message.parser';
import { USER_REGISTERED_TOPIC } from '../../src/infra/kafka/user-registered-message.parser';
import { withTestIdentity } from '../support/auth-testing';

jest.setTimeout(300_000);

const SERVICE_UNAVAILABLE_BODY = '{"statusCode":503,"message":"Service Unavailable"}';
const LOGGER_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * US-11 / US5: Orders starts and keeps its public parts and Kafka consumers working while
 * Identity's key set cannot be fetched; protected requests get 503 until Identity is back, then
 * succeed without a restart. Boots the full AppModule.
 */
describe('Identity unavailable — startup, 503 and recovery (component)', () => {
  const auth = withTestIdentity();
  const savedEnv: Record<string, string | undefined> = {};
  const captured: string[] = [];
  let postgresContainer: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let mongoContainer: StartedMongoDBContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let testProducer: Producer;
  let requestsAfterInit: number;
  const tokens: string[] = [];

  function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  /** Records everything logged or written to stdout/stderr, to prove no token leaks. */
  function captureOutput(): void {
    for (const method of LOGGER_METHODS) {
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
        captured.push(String(chunk));
        return original(chunk as string, ...rest);
      }) as typeof stream.write);
    }
  }

  beforeAll(async () => {
    captureOutput();
    auth.identity.setAvailable(false);

    [postgresContainer, kafkaContainer, mongoContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
      new MongoDBContainer('mongo:7').start(),
    ]);
    const kafkaBroker = `${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`;
    const suffix = randomUUID();
    setEnv({
      DB_HOST: postgresContainer.getHost(),
      DB_PORT: String(postgresContainer.getPort()),
      DB_USERNAME: postgresContainer.getUsername(),
      DB_PASSWORD: postgresContainer.getPassword(),
      DB_NAME: postgresContainer.getDatabase(),
      DB_MIGRATIONS_RUN: 'true',
      MONGO_URI: `${mongoContainer.getConnectionString()}/orders_read?directConnection=true`,
      KAFKA_BROKERS: kafkaBroker,
      KAFKA_CONSUMER_ENABLED: 'true',
      KAFKA_GROUP_ID: `payments-${suffix}`,
      KAFKA_INVENTORY_GROUP_ID: `inventory-${suffix}`,
      KAFKA_PROJECTION_GROUP_ID: `projection-${suffix}`,
      KAFKA_IDENTITY_GROUP_ID: `identity-${suffix}`,
      DEAD_LETTER_RETRY_ENABLED: 'false',
      PAYMENT_CONSUMER_MAX_ATTEMPTS: '3',
      PAYMENT_CONSUMER_BACKOFF_INITIAL_MS: '10',
      PAYMENT_CONSUMER_BACKOFF_MAX_MS: '50',
    });

    const testKafka = new Kafka({ clientId: 'test-harness', brokers: [kafkaBroker] });
    const admin = testKafka.admin();
    await admin.connect();
    await createTopicsWhenReady(admin, {
      waitForLeaders: true,
      topics: [
        USER_REGISTERED_TOPIC,
        ORDER_PLACED_TOPIC,
        ORDER_CANCELLED_TOPIC,
        ORDER_CONFIRMED_TOPIC,
        PAYMENT_PROCESSED_TOPIC,
        PAYMENT_FAILED_TOPIC,
        STOCK_RESERVED_TOPIC,
        STOCK_REJECTED_TOPIC,
      ].map((topic) => ({ topic, numPartitions: 1 })),
    });
    await admin.disconnect();

    // Imported here so the configuration is read after the env above and withTestIdentity's.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    setupSwagger(app);
    await app.init();
    requestsAfterInit = auth.identity.requestCount;
    dataSource = moduleRef.get(DataSource);

    testProducer = testKafka.producer();
    await testProducer.connect();
  });

  afterAll(async () => {
    await testProducer?.disconnect();
    await app?.close();
    await Promise.all([kafkaContainer?.stop(), postgresContainer?.stop(), mongoContainer?.stop()]);
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  async function customerToken(customerId: string): Promise<string> {
    const token = await auth.identity.customerToken(customerId);
    tokens.push(token);
    return token;
  }

  function placeOrder(token: string): request.Test {
    return request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 'prod-001', quantity: 1, unitPrice: 10 }] });
  }

  it('starts without asking Identity for keys', () => {
    expect(requestsAfterInit).toBe(0);
  });

  it('serves the Swagger document', async () => {
    const response = await request(app.getHttpServer()).get('/api-json');
    expect(response.status).toBe(200);
  });

  it('keeps consuming identity.user-registered, then answers 503 and recovers without a restart', async () => {
    const customerId = randomUUID();
    const userId = randomUUID();
    await testProducer.send({
      topic: USER_REGISTERED_TOPIC,
      messages: [
        {
          key: userId,
          value: JSON.stringify({
            eventId: randomUUID(),
            aggregateId: userId,
            occurredAt: new Date().toISOString(),
            version: 1,
            customerId,
            name: 'Ada Lovelace',
            email: 'ada@example.com',
          }),
        },
      ],
    });
    await waitFor(async () => {
      expect(await dataSource.getRepository(CustomerEntity).existsBy({ id: customerId })).toBe(
        true,
      );
    }, 120_000);

    const token = await customerToken(customerId);
    const unavailable = await placeOrder(token);
    expect(unavailable.status).toBe(503);
    expect(unavailable.text).toBe(SERVICE_UNAVAILABLE_BODY);
    expect(unavailable.headers['www-authenticate']).toBeUndefined();

    auth.identity.setAvailable(true);
    const placed = await placeOrder(token);
    expect(placed.status).toBe(201);
  });

  it('never writes a token to the logs or the console', () => {
    expect(tokens.length).toBeGreaterThan(0);
    const output = captured.join('\n');
    for (const token of tokens) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(token.slice(0, 20));
    }
  });
});
