import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { AddressInfo, Server, Socket, createConnection, createServer } from 'net';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Consumer, Kafka, Producer } from 'kafkajs';
import { createTopicsWhenReady } from './support/kafka-testing';
import configuration from '../../src/config/configuration';
import { KafkaModule } from '../../src/infra/kafka/kafka.module';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../src/infra/kafka/order-events.producer';
import {
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
} from '../../src/infra/kafka/payment-message.parser';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import { OrderEntity } from '../../src/infra/database/entities/order.entity';
import { OrderItemEntity } from '../../src/infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import { ConsumedMessageDeadLetterEntity } from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { DeadLetterStatus } from '../../src/infra/database/entities/dead-letter-status.enum';
import { OrderStatus } from '../../src/domain/order-status.enum';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { ProcessedEventRepository } from '../../src/repositories/processed-event.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { ReactToPaymentOutcomeService } from '../../src/services/react-to-payment-outcome.service';
import { PaymentEventsConsumer } from '../../src/infra/kafka/payment-events.consumer';
import { OrderProjectionConsumer } from '../../src/infra/kafka/order-projection.consumer';
import { OrderProjectionService } from '../../src/read-model/order-projection.service';
import { OrdersController } from '../../src/controllers/orders.controller';
import { DeadLetterRetryWorker } from '../../src/infra/dead-letter/dead-letter-retry.worker';

jest.setTimeout(240_000);

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
/** Startup and a publish to an unreachable broker must both stay well under this. */
const PROMPT_MS = 5_000;

/** Env vars this suite overrides; restored in afterAll. */
const ENV: Record<string, string> = {
  KAFKA_CONSUMER_ENABLED: 'true',
  KAFKA_CONNECTION_TIMEOUT_MS: '1000',
  KAFKA_PRODUCER_RETRIES: '1',
  PAYMENT_CONSUMER_BACKOFF_INITIAL_MS: '200',
  PAYMENT_CONSUMER_BACKOFF_MAX_MS: '1000',
  KAFKA_GROUP_ID: 'lazy-connect-payments',
  KAFKA_PROJECTION_GROUP_ID: 'lazy-connect-projection',
  DEAD_LETTER_RETRY_ENABLED: 'true',
  DEAD_LETTER_RETRY_INTERVAL_MS: '300',
  DEAD_LETTER_BASE_DELAY_MS: '200',
  DEAD_LETTER_MAX_DELAY_MS: '1000',
  DEAD_LETTER_MAX_RETRIES: '1000',
};

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 30_000): Promise<void> {
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * The broker address the application is given. Closed at first (connections are refused, as
 * with Kafka down); `open()` starts forwarding to the real broker. Kafka then advertises the
 * container's own address, so clients only use this for bootstrap.
 */
class BrokerGate {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    readonly port: number,
    private readonly target: { host: string; port: number },
  ) {}

  static async reservePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  async open(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = createConnection(this.target);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => this.server?.listen(this.port, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    this.sockets.forEach((socket) => socket.destroy());
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

interface ObservedEvent {
  eventId: string;
  aggregateId: string;
}

describe('Starting and serving while Kafka is unavailable (component)', () => {
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let gate: BrokerGate;
  let app: INestApplication;
  let dataSource: DataSource;
  let directKafka: Kafka;
  let observer: Consumer;
  let paymentsProducer: Producer;
  const observed: ObservedEvent[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  let startupMs = 0;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    kafka = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').start();
    const kafkaPort = kafka.getMappedPort(9093);
    directKafka = new Kafka({
      clientId: 'lazy-connect-test',
      brokers: [`${kafka.getHost()}:${kafkaPort}`],
    });
    const admin = directKafka.admin();
    await admin.connect();
    await createTopicsWhenReady(admin, {
      topics: [
        ORDER_PLACED_TOPIC,
        ORDER_CONFIRMED_TOPIC,
        ORDER_CANCELLED_TOPIC,
        PAYMENT_PROCESSED_TOPIC,
        PAYMENT_FAILED_TOPIC,
      ].map((topic) => ({ topic, numPartitions: 1 })),
    });
    await admin.disconnect();

    gate = new BrokerGate(await BrokerGate.reservePort(), { host: '127.0.0.1', port: kafkaPort });
    for (const [key, value] of Object.entries({
      ...ENV,
      KAFKA_BROKERS: `127.0.0.1:${gate.port}`,
    })) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: postgres.getHost(),
          port: postgres.getPort(),
          username: postgres.getUsername(),
          password: postgres.getPassword(),
          database: postgres.getDatabase(),
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
        ConfirmOrderService,
        CancelOrderService,
        ReactToPaymentOutcomeService,
        OrderRepository,
        OrderDeadLetterRepository,
        CustomerRepository,
        ProcessedEventRepository,
        ConsumedMessageDeadLetterRepository,
        OrderEventsProducer,
        PaymentEventsConsumer,
        OrderProjectionConsumer,
        // MongoDB is not part of this scenario: the projection consumer runs against a stub.
        { provide: OrderProjectionService, useValue: { project: jest.fn() } },
        DeadLetterRetryWorker,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    const started = Date.now();
    await app.init(); // Kafka is unreachable: this must not wait for it
    startupMs = Date.now() - started;

    dataSource = moduleRef.get(DataSource);
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: CUSTOMER_ID, createdAt: new Date() });
  });

  afterAll(async () => {
    await observer?.disconnect();
    await paymentsProducer?.disconnect();
    await app?.close();
    await gate?.close();
    await kafka?.stop();
    await postgres?.stop();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should start, accept an order promptly and dead-letter its event, then publish it once Kafka is reachable', async () => {
    expect(startupMs).toBeLessThan(PROMPT_MS);

    // 1. Kafka unreachable: the order is accepted promptly and its event dead-lettered.
    const started = Date.now();
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: CUSTOMER_ID, items: [{ productId: 'p-1', quantity: 1, unitPrice: 10 }] });
    const elapsedMs = Date.now() - started;

    expect(response.status).toBe(201);
    expect(elapsedMs).toBeLessThan(PROMPT_MS);
    const orderId = (response.body as { orderId: string }).orderId;
    const deadLetters = dataSource.getRepository(OrderDeadLetterEntity);
    const [pending] = (await deadLetters.find()).filter(
      (row) => row.payload.aggregateId === orderId,
    );
    expect(pending.status).toBe(DeadLetterStatus.PENDING_RETRY);

    // 2. Kafka becomes reachable: the retry worker publishes the same event.
    observer = directKafka.consumer({ groupId: `observer-${randomUUID()}` });
    await observer.connect();
    await observer.subscribe({ topic: ORDER_PLACED_TOPIC, fromBeginning: true });
    await observer.run({
      eachMessage: async ({ message }) => {
        if (message.value) {
          observed.push(JSON.parse(message.value.toString()) as ObservedEvent);
        }
      },
    });
    await gate.open();

    await waitFor(async () => {
      const row = await deadLetters.findOneByOrFail({ id: pending.id });
      expect(row.status).toBe(DeadLetterStatus.RESOLVED);
    });
    await waitFor(() => {
      expect(observed.filter((event) => event.aggregateId === orderId)).toEqual([
        expect.objectContaining({ eventId: pending.eventId }),
      ]);
    });

    // 3. The payment consumer, started while Kafka was down, has reconnected and consumes.
    paymentsProducer = directKafka.producer();
    await paymentsProducer.connect();
    await paymentsProducer.send({
      topic: PAYMENT_PROCESSED_TOPIC,
      messages: [
        {
          value: JSON.stringify({
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            aggregateId: randomUUID(),
            version: 1,
            orderId,
            amount: 10,
            currency: 'USD',
            processedAt: new Date().toISOString(),
          }),
        },
      ],
    });
    await waitFor(async () => {
      const order = await dataSource.getRepository(OrderEntity).findOneByOrFail({ id: orderId });
      expect(order.status).toBe(OrderStatus.CONFIRMED);
    }, 60_000);
  });
});
