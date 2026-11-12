import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Consumer, Kafka, Producer } from 'kafkajs';
import { createTopicsWhenReady } from './support/kafka-testing';
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
import { DeadLetterStatus } from '../../src/infra/database/entities/dead-letter-status.enum';
import { OrderRepository } from '../../src/repositories/order.repository';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { PlaceOrderService } from '../../src/services/place-order.service';
import { OrdersController } from '../../src/controllers/orders.controller';
import { DeadLetterRetryWorker } from '../../src/infra/dead-letter/dead-letter-retry.worker';
import { ProcessedEventEntity } from '../../src/infra/database/entities/processed-event.entity';
import {
  ConsumedMessageDeadLetterEntity,
  ConsumedMessageFailureType,
} from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { OrderStatus } from '../../src/domain/order-status.enum';
import { ProcessedEventRepository } from '../../src/repositories/processed-event.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { ConfirmOrderService } from '../../src/services/confirm-order.service';
import { CancelOrderService } from '../../src/services/cancel-order.service';
import { ReactToPaymentOutcomeService } from '../../src/services/react-to-payment-outcome.service';
import { PaymentEventsConsumer } from '../../src/infra/kafka/payment-events.consumer';
import { OrderProjectionConsumer } from '../../src/infra/kafka/order-projection.consumer';
import { OrderProjectionService } from '../../src/read-model/order-projection.service';
import { PAYMENT_PROCESSED_TOPIC } from '../../src/infra/kafka/payment-message.parser';

jest.setTimeout(240_000);

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** Env vars this suite overrides; restored in afterAll. */
const ENV = {
  DEAD_LETTER_RETRY_ENABLED: 'true',
  DEAD_LETTER_RETRY_INTERVAL_MS: '200',
  DEAD_LETTER_BASE_DELAY_MS: '100',
  DEAD_LETTER_MAX_DELAY_MS: '1000',
  DEAD_LETTER_MAX_RETRIES: '3',
  KAFKA_CONSUMER_ENABLED: 'false',
};

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 15_000): Promise<void> {
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

interface ObservedEvent {
  eventId: string;
  aggregateId: string;
}

describe('Dead-letter retry (component, Kafka + PostgreSQL)', () => {
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let kafkaProducer: Producer;
  let observer: Consumer;
  const observed: ObservedEvent[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    kafka = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').start();
    const broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    savedEnv.KAFKA_BROKERS = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = broker;

    const observerKafka = new Kafka({ clientId: 'dl-observer', brokers: [broker] });
    const admin = observerKafka.admin();
    await admin.connect();
    await createTopicsWhenReady(admin, {
      topics: [{ topic: ORDER_PLACED_TOPIC, numPartitions: 1 }],
    });
    await admin.disconnect();

    observer = observerKafka.consumer({ groupId: 'dl-observer-group' });
    await observer.connect();
    await observer.subscribe({ topic: ORDER_PLACED_TOPIC, fromBeginning: true });
    await observer.run({
      eachMessage: async ({ message }) => {
        if (message.value) {
          observed.push(JSON.parse(message.value.toString()) as ObservedEvent);
        }
      },
    });

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
        // The inbound cases here are payment messages, so MongoDB is not needed: the projection
        // service (a dependency of OrderProjectionConsumer, which the worker routes orders.*
        // rows to) is a stub. Projection retries are covered by the worker unit tests.
        { provide: OrderProjectionService, useValue: { project: jest.fn() } },
        DeadLetterRetryWorker,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    kafkaProducer = moduleRef.get<Producer>(KAFKA_PRODUCER);
    await dataSource
      .getRepository(CustomerEntity)
      .insert({ id: CUSTOMER_ID, createdAt: new Date() });
  });

  afterAll(async () => {
    await observer?.disconnect();
    await app?.close();
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

  async function deadLetterFor(orderId: string): Promise<OrderDeadLetterEntity[]> {
    const rows = await dataSource.getRepository(OrderDeadLetterEntity).find();
    return rows.filter((row) => row.payload.aggregateId === orderId);
  }

  it('should republish an event that failed to publish once Kafka accepts it, with the same eventId', async () => {
    const send = jest
      .spyOn(kafkaProducer, 'send')
      .mockRejectedValueOnce(new Error('simulated broker outage'));

    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: CUSTOMER_ID, items: [{ productId: 'p-1', quantity: 1, unitPrice: 10 }] });
    expect(response.status).toBe(201);
    const orderId = (response.body as { orderId: string }).orderId;

    // The order is saved and the failed event is dead-lettered, pending retry.
    expect(await dataSource.getRepository(OrderEntity).findOneBy({ id: orderId })).not.toBeNull();
    const [pending] = await deadLetterFor(orderId);
    expect(pending.status).toBe(DeadLetterStatus.PENDING_RETRY);

    // The worker republishes it on a later cycle (send is real again after the first call).
    await waitFor(async () => {
      const [row] = await deadLetterFor(orderId);
      expect(row.status).toBe(DeadLetterStatus.RESOLVED);
      expect(row.resolvedAt).not.toBeNull();
    });
    await waitFor(() => {
      expect(observed.filter((event) => event.aggregateId === orderId)).toHaveLength(1);
    });
    const event = observed.find((e) => e.aggregateId === orderId);
    expect(event?.eventId).toBe(pending.eventId);
    send.mockRestore();
  });

  async function placeOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: CUSTOMER_ID, items: [{ productId: 'p-2', quantity: 2, unitPrice: 5 }] });
    expect(response.status).toBe(201);
    return (response.body as { orderId: string }).orderId;
  }

  /** Stores a payments.payment-processed message as an inbound dead letter, due now. */
  async function deadLetterPayment(orderId: string, eventId: string): Promise<string> {
    const id = randomUUID();
    const rawValue = JSON.stringify({
      eventId,
      occurredAt: new Date().toISOString(),
      aggregateId: randomUUID(),
      version: 1,
      orderId,
      amount: 10,
      currency: 'USD',
      processedAt: new Date().toISOString(),
    });
    await dataSource.getRepository(ConsumedMessageDeadLetterEntity).insert({
      id,
      topic: PAYMENT_PROCESSED_TOPIC,
      partition: 0,
      offset: '0',
      messageKey: null,
      rawValue,
      eventId,
      orderId,
      failureType: ConsumedMessageFailureType.RETRIES_EXHAUSTED,
      error: 'simulated earlier failure',
      attempts: 5,
    });
    return id;
  }

  async function inboundRow(id: string): Promise<ConsumedMessageDeadLetterEntity> {
    return dataSource.getRepository(ConsumedMessageDeadLetterEntity).findOneByOrFail({ id });
  }

  it('should re-handle a dead-lettered payment message, and resolve its duplicate without a second confirmation', async () => {
    const orderId = await placeOrder();
    const eventId = randomUUID();

    const first = await deadLetterPayment(orderId, eventId);
    await waitFor(async () => {
      expect((await inboundRow(first)).status).toBe(DeadLetterStatus.RESOLVED);
    });
    const order = await dataSource.getRepository(OrderEntity).findOneByOrFail({ id: orderId });
    expect(order.status).toBe(OrderStatus.CONFIRMED);

    const duplicate = await deadLetterPayment(orderId, eventId);
    await waitFor(async () => {
      expect((await inboundRow(duplicate)).status).toBe(DeadLetterStatus.RESOLVED);
    });
    expect(await dataSource.getRepository(ProcessedEventEntity).countBy({ eventId })).toBe(1);
  });
});
