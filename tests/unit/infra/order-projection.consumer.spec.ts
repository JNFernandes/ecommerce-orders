import { Logger } from '@nestjs/common';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { OrderProjectionConsumer } from '../../../src/infra/kafka/order-projection.consumer';
import { ORDER_PLACED_TOPIC } from '../../../src/infra/kafka/order-events.producer';
import { KafkaConfig } from '../../../src/config/configuration';
import { OrderProjectionService } from '../../../src/read-model/order-projection.service';
import {
  OrderViewConcurrencyError,
  ReadModelUnavailableError,
} from '../../../src/read-model/errors';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';

const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const KAFKA_CONFIG: KafkaConfig = {
  brokers: ['localhost:9092'],
  clientId: 'test',
  groupId: 'payments-group',
  projectionGroupId: 'projection-group',
  consumerEnabled: true,
  maxAttempts: 3,
  backoffInitialMs: 1,
  backoffMaxMs: 2,
};

function placedValue(): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: EVENT_ID,
      occurredAt: '2026-11-11T10:00:00.000Z',
      aggregateId: ORDER_ID,
      version: 1,
      customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      items: [{ productId: 'p-1', quantity: 1, unitPrice: 10 }],
      totalAmount: 10,
    }),
  );
}

function payloadFor(value: Buffer | null): EachMessagePayload {
  return {
    topic: ORDER_PLACED_TOPIC,
    partition: 1,
    message: {
      key: Buffer.from(ORDER_ID),
      value,
      timestamp: '0',
      attributes: 0,
      offset: '9',
      headers: {},
    },
    heartbeat: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  } as unknown as EachMessagePayload;
}

function build(project: jest.Mock = jest.fn().mockResolvedValue('applied')): {
  consumer: OrderProjectionConsumer;
  kafka: Kafka;
  kafkaConsumer: Consumer;
  deadLetters: ConsumedMessageDeadLetterRepository;
} {
  const kafkaConsumer = {
    commitOffsets: jest.fn().mockResolvedValue(undefined),
  } as unknown as Consumer;
  const kafka = { consumer: jest.fn().mockReturnValue(kafkaConsumer) } as unknown as Kafka;
  const configService = {
    get: jest.fn().mockReturnValue(KAFKA_CONFIG),
  } as unknown as ConfigService;
  const projectionService = { project } as unknown as OrderProjectionService;
  const deadLetters = {
    recordMalformed: jest.fn().mockResolvedValue(undefined),
    recordRetriesExhausted: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConsumedMessageDeadLetterRepository;

  const consumer = new OrderProjectionConsumer(
    kafka,
    configService,
    projectionService,
    deadLetters,
  );
  return { consumer, kafka, kafkaConsumer, deadLetters };
}

const COMMIT = [{ topic: ORDER_PLACED_TOPIC, partition: 1, offset: '10' }];

describe('OrderProjectionConsumer', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('should join its own projection consumer group, not the payment one', () => {
    const { kafka } = build();

    expect(kafka.consumer).toHaveBeenCalledWith({ groupId: 'projection-group' });
  });

  it('should project a valid event and then commit offset + 1', async () => {
    const project = jest.fn().mockResolvedValue('applied');
    const { consumer, kafkaConsumer, deadLetters } = build(project);

    await consumer.handleMessage(payloadFor(placedValue()));

    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OrderPlaced', eventId: EVENT_ID, orderId: ORDER_ID }),
    );
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(COMMIT);
    expect(deadLetters.recordMalformed).not.toHaveBeenCalled();
  });

  it('should dead-letter a malformed event without projecting it, then commit', async () => {
    const project = jest.fn();
    const { consumer, kafkaConsumer, deadLetters } = build(project);

    await consumer.handleMessage(payloadFor(Buffer.from('not json')));

    expect(project).not.toHaveBeenCalled();
    expect(deadLetters.recordMalformed).toHaveBeenCalledWith(
      expect.objectContaining({ topic: ORDER_PLACED_TOPIC, rawValue: 'not json', offset: '9' }),
      expect.any(Error),
    );
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(COMMIT);
  });

  it('should retry a write conflict and commit once it succeeds', async () => {
    const project = jest
      .fn()
      .mockRejectedValueOnce(new OrderViewConcurrencyError(ORDER_ID))
      .mockResolvedValue('applied');
    const { consumer, kafkaConsumer, deadLetters } = build(project);

    await consumer.handleMessage(payloadFor(placedValue()));

    expect(project).toHaveBeenCalledTimes(2);
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(COMMIT);
  });

  it('should dead-letter after maxAttempts unexpected failures, then commit', async () => {
    const boom = new Error('boom');
    const { consumer, kafkaConsumer, deadLetters } = build(jest.fn().mockRejectedValue(boom));

    await consumer.handleMessage(payloadFor(placedValue()));

    expect(deadLetters.recordRetriesExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, orderId: ORDER_ID, topic: ORDER_PLACED_TOPIC }),
      boom,
      3,
    );
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(COMMIT);
  });

  it('should NOT dead-letter or commit when the read model is unavailable, so it is redelivered', async () => {
    const outage = new ReadModelUnavailableError(new Error('ECONNREFUSED'));
    const project = jest.fn().mockRejectedValue(outage);
    const { consumer, kafkaConsumer, deadLetters } = build(project);

    await expect(consumer.handleMessage(payloadFor(placedValue()))).rejects.toBe(outage);

    expect(project).toHaveBeenCalledTimes(3);
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
    expect(kafkaConsumer.commitOffsets).not.toHaveBeenCalled();
  });
});

describe('OrderProjectionConsumer.process (dead-letter retry entry point)', () => {
  it('should list the order topics it owns', () => {
    expect(build().consumer.topics).toEqual([
      'orders.order-placed',
      'orders.order-confirmed',
      'orders.order-cancelled',
    ]);
  });

  it('should parse and project once, without retrying, dead-lettering or committing', async () => {
    const project = jest.fn().mockResolvedValue('applied');
    const { consumer, kafkaConsumer, deadLetters } = build(project);

    await consumer.process(ORDER_PLACED_TOPIC, placedValue());

    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0][0]).toMatchObject({ eventId: EVENT_ID, orderId: ORDER_ID });
    expect(kafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    expect(deadLetters.recordMalformed).not.toHaveBeenCalled();
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
  });

  it('should reject a malformed value with MalformedMessageError', async () => {
    await expect(build().consumer.process(ORDER_PLACED_TOPIC, null)).rejects.toBeInstanceOf(
      MalformedMessageError,
    );
  });

  it('should propagate a projection error after a single attempt', async () => {
    const project = jest.fn().mockRejectedValue(new ReadModelUnavailableError('down'));

    await expect(
      build(project).consumer.process(ORDER_PLACED_TOPIC, placedValue()),
    ).rejects.toThrow(ReadModelUnavailableError);
    expect(project).toHaveBeenCalledTimes(1);
  });
});
