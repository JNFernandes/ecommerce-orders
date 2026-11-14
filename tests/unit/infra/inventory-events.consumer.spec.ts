import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { InventoryEventsConsumer } from '../../../src/infra/kafka/inventory-events.consumer';
import {
  STOCK_REJECTED_TOPIC,
  STOCK_RESERVED_TOPIC,
} from '../../../src/infra/kafka/stock-message.parser';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import { ApplyStockOutcomeCommand } from '../../../src/commands/apply-stock-outcome.command';
import { StockOutcome } from '../../../src/domain/stock-outcome.enum';
import { KafkaConfig } from '../../../src/config/configuration';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';
import { OrderNotFoundForOutcomeError } from '../../../src/services/errors/outcome.errors';

const EVENT_ID = '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11';
const RESERVATION_ID = '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33';
const ORDER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';

const KAFKA_CONFIG: KafkaConfig = {
  brokers: ['localhost:9092'],
  clientId: 'test',
  groupId: 'test-group',
  projectionGroupId: 'test-projection-group',
  inventoryGroupId: 'test-inventory-group',
  consumerEnabled: true,
  maxAttempts: 3,
  backoffInitialMs: 1,
  backoffMaxMs: 2,
  connectionTimeoutMs: 1000,
  producerRetries: 1,
};

function reservedValue(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: EVENT_ID,
      aggregateId: RESERVATION_ID,
      occurredAt: '2026-11-14T10:00:01.000Z',
      version: 1,
      orderId: ORDER_ID,
      items: [{ productId: 'sku-1', quantity: 1 }],
      reservedAt: '2026-11-14T10:00:01.000Z',
      ...overrides,
    }),
  );
}

function payloadFor(value: Buffer | null, topic = STOCK_RESERVED_TOPIC): EachMessagePayload {
  return {
    topic,
    partition: 1,
    message: {
      key: Buffer.from(RESERVATION_ID),
      value,
      timestamp: '0',
      attributes: 0,
      offset: '7',
      headers: {},
    },
    heartbeat: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  } as unknown as EachMessagePayload;
}

function buildConsumer(
  dispatch: jest.Mock = jest.fn().mockResolvedValue(undefined),
  config: KafkaConfig = KAFKA_CONFIG,
): {
  consumer: InventoryEventsConsumer;
  kafka: Kafka;
  kafkaConsumer: Consumer;
  deadLetters: ConsumedMessageDeadLetterRepository;
} {
  const kafkaConsumer = {
    commitOffsets: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  } as unknown as Consumer;
  const kafka = { consumer: jest.fn().mockReturnValue(kafkaConsumer) } as unknown as Kafka;
  const commandBus = { execute: dispatch } as unknown as CommandBus;
  const configService = { get: jest.fn().mockReturnValue(config) } as unknown as ConfigService;
  const deadLetters = {
    recordMalformed: jest.fn().mockResolvedValue(undefined),
    recordRetriesExhausted: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConsumedMessageDeadLetterRepository;

  const consumer = new InventoryEventsConsumer(kafka, commandBus, configService, deadLetters);
  return { consumer, kafka, kafkaConsumer, deadLetters };
}

const EXPECTED_COMMIT = [{ topic: STOCK_RESERVED_TOPIC, partition: 1, offset: '8' }];

describe('InventoryEventsConsumer.handleMessage', () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    logSpies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('should use its own consumer group', () => {
    const { kafka } = buildConsumer();

    expect(kafka.consumer).toHaveBeenCalledWith({ groupId: 'test-inventory-group' });
  });

  it('should dispatch ApplyStockOutcomeCommand keyed by orderId and then commit offset + 1', async () => {
    const calls: string[] = [];
    const dispatch = jest.fn().mockImplementation(async () => {
      calls.push('dispatch');
    });
    const { consumer, kafkaConsumer } = buildConsumer(dispatch);
    (kafkaConsumer.commitOffsets as jest.Mock).mockImplementation(async () => {
      calls.push('commit');
    });

    await consumer.handleMessage(payloadFor(reservedValue()));

    expect(dispatch).toHaveBeenCalledWith(
      new ApplyStockOutcomeCommand(StockOutcome.RESERVED, {
        eventId: EVENT_ID,
        topic: STOCK_RESERVED_TOPIC,
        orderId: ORDER_ID,
        reservationId: RESERVATION_ID,
      }),
    );
    expect(calls).toEqual(['dispatch', 'commit']);
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
  });

  it('should pass the rejection reason of a stock-rejected message', async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const { consumer } = buildConsumer(dispatch);

    await consumer.handleMessage(
      payloadFor(reservedValue({ reason: 'insufficient stock' }), STOCK_REJECTED_TOPIC),
    );

    const command = dispatch.mock.calls[0][0] as ApplyStockOutcomeCommand;
    expect(command.outcome).toBe(StockOutcome.REJECTED);
    expect(command.reason).toBe('insufficient stock');
    expect(command.inboundEvent.orderId).toBe(ORDER_ID);
  });

  it('should dead-letter a malformed message once, without dispatching, then commit', async () => {
    const dispatch = jest.fn();
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.handleMessage(payloadFor(reservedValue({ orderId: 'abc' })));

    expect(dispatch).not.toHaveBeenCalled();
    expect(deadLetters.recordMalformed).toHaveBeenCalledTimes(1);
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
  });

  it('should retry a failure that persists through every attempt, dead-letter it as retryable, then commit', async () => {
    const dispatch = jest
      .fn()
      .mockRejectedValue(new OrderNotFoundForOutcomeError(ORDER_ID, STOCK_RESERVED_TOPIC));
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.handleMessage(payloadFor(reservedValue()));

    expect(dispatch).toHaveBeenCalledTimes(KAFKA_CONFIG.maxAttempts);
    expect(deadLetters.recordRetriesExhausted).toHaveBeenCalledTimes(1);
    expect(deadLetters.recordMalformed).not.toHaveBeenCalled();
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
  });

  it('should treat a database failure like any other retryable failure (not fatal)', async () => {
    const dispatch = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue(undefined);
    const { consumer, deadLetters, kafkaConsumer } = buildConsumer(dispatch);

    await consumer.handleMessage(payloadFor(reservedValue()));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledTimes(1);
  });
});

describe('InventoryEventsConsumer.process (dead-letter retry entry point)', () => {
  it('should list the stock topics it owns', () => {
    const { consumer } = buildConsumer();

    expect([...consumer.topics]).toEqual([STOCK_RESERVED_TOPIC, STOCK_REJECTED_TOPIC]);
  });

  it('should parse and dispatch once, without retrying, dead-lettering or committing', async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.process(STOCK_RESERVED_TOPIC, reservedValue());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBeInstanceOf(ApplyStockOutcomeCommand);
    expect(kafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
  });

  it('should reject a malformed value with MalformedMessageError', async () => {
    const { consumer } = buildConsumer();

    await expect(
      consumer.process(STOCK_RESERVED_TOPIC, Buffer.from('nope')),
    ).rejects.toBeInstanceOf(MalformedMessageError);
  });
});

describe('InventoryEventsConsumer startup and shutdown', () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    jest.useFakeTimers();
    logSpies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('should not connect when the consumers are disabled', async () => {
    const { consumer, kafkaConsumer } = buildConsumer(undefined, {
      ...KAFKA_CONFIG,
      consumerEnabled: false,
    });

    consumer.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(kafkaConsumer.connect).not.toHaveBeenCalled();
  });

  it('should not block bootstrap, and keep retrying a failed connect in the background until it runs', async () => {
    const { consumer, kafkaConsumer } = buildConsumer();
    (kafkaConsumer.connect as jest.Mock)
      .mockReset()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);

    expect(consumer.onApplicationBootstrap()).toBeUndefined();
    await jest.advanceTimersByTimeAsync(0);
    expect(kafkaConsumer.run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(kafkaConsumer.connect).toHaveBeenCalledTimes(2);
    expect(kafkaConsumer.subscribe).toHaveBeenCalledWith({
      topics: [STOCK_RESERVED_TOPIC, STOCK_REJECTED_TOPIC],
      fromBeginning: true,
    });
    expect(kafkaConsumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));
    await consumer.onApplicationShutdown();
    expect(kafkaConsumer.disconnect).toHaveBeenCalled();
  });
});
