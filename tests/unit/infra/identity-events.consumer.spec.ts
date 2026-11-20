import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { IdentityEventsConsumer } from '../../../src/infra/kafka/identity-events.consumer';
import { USER_REGISTERED_TOPIC } from '../../../src/infra/kafka/user-registered-message.parser';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import { CreateCustomerCommand } from '../../../src/commands/create-customer.command';
import { KafkaConfig } from '../../../src/config/configuration';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';

const EVENT_ID = '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11';
const USER_ID = '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33';
const CUSTOMER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';

const KAFKA_CONFIG: KafkaConfig = {
  brokers: ['localhost:9092'],
  clientId: 'test',
  groupId: 'test-group',
  projectionGroupId: 'test-projection-group',
  inventoryGroupId: 'test-inventory-group',
  identityGroupId: 'test-identity-group',
  consumerEnabled: true,
  maxAttempts: 3,
  backoffInitialMs: 1,
  backoffMaxMs: 2,
  connectionTimeoutMs: 1000,
  producerRetries: 1,
};

function registeredValue(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: EVENT_ID,
      aggregateId: USER_ID,
      occurredAt: '2026-11-19T10:00:00.000Z',
      version: 1,
      customerId: CUSTOMER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      ...overrides,
    }),
  );
}

function payloadFor(value: Buffer | null): EachMessagePayload {
  return {
    topic: USER_REGISTERED_TOPIC,
    partition: 1,
    message: {
      key: Buffer.from(USER_ID),
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

function buildConsumer(dispatch: jest.Mock = jest.fn().mockResolvedValue(undefined)): {
  consumer: IdentityEventsConsumer;
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
  const configService = {
    get: jest.fn().mockReturnValue(KAFKA_CONFIG),
  } as unknown as ConfigService;
  const deadLetters = {
    recordMalformed: jest.fn().mockResolvedValue(undefined),
    recordRetriesExhausted: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConsumedMessageDeadLetterRepository;

  const consumer = new IdentityEventsConsumer(kafka, commandBus, configService, deadLetters);
  return { consumer, kafka, kafkaConsumer, deadLetters };
}

describe('IdentityEventsConsumer', () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    logSpies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('should use its own consumer group and own identity.user-registered', () => {
    const { consumer, kafka } = buildConsumer();

    expect(kafka.consumer).toHaveBeenCalledWith({ groupId: 'test-identity-group' });
    expect([...consumer.topics]).toEqual([USER_REGISTERED_TOPIC]);
  });

  it('should dispatch CreateCustomerCommand keyed by customerId (never aggregateId), then commit offset + 1', async () => {
    const calls: string[] = [];
    const dispatch = jest.fn().mockImplementation(async () => {
      calls.push('dispatch');
    });
    const { consumer, kafkaConsumer } = buildConsumer(dispatch);
    (kafkaConsumer.commitOffsets as jest.Mock).mockImplementation(async () => {
      calls.push('commit');
    });

    await consumer.handleMessage(payloadFor(registeredValue()));

    expect(dispatch).toHaveBeenCalledWith(
      new CreateCustomerCommand(CUSTOMER_ID, 'Ada Lovelace', 'ada@example.com', {
        eventId: EVENT_ID,
        topic: USER_REGISTERED_TOPIC,
        customerId: CUSTOMER_ID,
      }),
    );
    expect(JSON.stringify(dispatch.mock.calls[0][0])).not.toContain(USER_ID);
    expect(calls).toEqual(['dispatch', 'commit']);
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: USER_REGISTERED_TOPIC, partition: 1, offset: '8' },
    ]);
  });

  it('should dead-letter a malformed message once, without dispatching, then commit', async () => {
    const dispatch = jest.fn();
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.handleMessage(payloadFor(registeredValue({ email: undefined })));

    expect(dispatch).not.toHaveBeenCalled();
    expect(deadLetters.recordMalformed).toHaveBeenCalledTimes(1);
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: USER_REGISTERED_TOPIC, partition: 1, offset: '8' },
    ]);
  });

  it('should retry a repository failure through every attempt, dead-letter it as retryable, then commit', async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error('connection terminated'));
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.handleMessage(payloadFor(registeredValue()));

    expect(dispatch).toHaveBeenCalledTimes(KAFKA_CONFIG.maxAttempts);
    expect(deadLetters.recordRetriesExhausted).toHaveBeenCalledTimes(1);
    expect(deadLetters.recordMalformed).not.toHaveBeenCalled();
    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('process() should parse and dispatch once, without retrying, dead-lettering or committing', async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

    await consumer.process(USER_REGISTERED_TOPIC, registeredValue());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBeInstanceOf(CreateCustomerCommand);
    expect(kafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
  });

  it('process() should reject a malformed value with MalformedMessageError', async () => {
    const { consumer } = buildConsumer();

    await expect(
      consumer.process(USER_REGISTERED_TOPIC, Buffer.from('nope')),
    ).rejects.toBeInstanceOf(MalformedMessageError);
  });
});
