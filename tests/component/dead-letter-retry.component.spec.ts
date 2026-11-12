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

jest.setTimeout(240_000);

const CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** Env vars this suite overrides; restored in afterAll. */
const ENV = {
  DEAD_LETTER_RETRY_ENABLED: 'true',
  DEAD_LETTER_RETRY_INTERVAL_MS: '200',
  DEAD_LETTER_BASE_DELAY_MS: '100',
  DEAD_LETTER_MAX_DELAY_MS: '1000',
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
});
