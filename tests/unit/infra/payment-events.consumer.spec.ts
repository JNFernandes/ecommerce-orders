import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { PaymentEventsConsumer } from '../../../src/infra/kafka/payment-events.consumer';
import { PAYMENT_PROCESSED_TOPIC } from '../../../src/infra/kafka/payment-message.parser';
import { ReactToPaymentOutcomeCommand } from '../../../src/commands/react-to-payment-outcome.command';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import { KafkaConfig } from '../../../src/config/configuration';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';
import { OrderNotFoundForPaymentError } from '../../../src/services/errors/payment-outcome.errors';

const EVENT_ID = '9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3';
const PAYMENT_ID = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const KAFKA_CONFIG: KafkaConfig = {
  brokers: ['localhost:9092'],
  clientId: 'test',
  groupId: 'test-group',
  consumerEnabled: true,
  maxAttempts: 3,
  backoffInitialMs: 1,
  backoffMaxMs: 2,
};

function processedValue(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: EVENT_ID,
      occurredAt: '2026-07-09T14:32:01Z',
      aggregateId: PAYMENT_ID,
      version: 1,
      orderId: ORDER_ID,
      amount: 10,
      currency: 'USD',
      processedAt: '2026-07-09T14:32:01Z',
      ...overrides,
    }),
  );
}

function payloadFor(value: Buffer | null, topic = PAYMENT_PROCESSED_TOPIC): EachMessagePayload {
  return {
    topic,
    partition: 2,
    message: {
      key: Buffer.from(PAYMENT_ID),
      value,
      timestamp: '0',
      attributes: 0,
      offset: '41',
      headers: {},
    },
    heartbeat: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  } as unknown as EachMessagePayload;
}

function buildConsumer(dispatch: jest.Mock = jest.fn().mockResolvedValue(undefined)): {
  consumer: PaymentEventsConsumer;
  kafkaConsumer: Consumer;
  deadLetters: ConsumedMessageDeadLetterRepository;
} {
  const kafkaConsumer = {
    commitOffsets: jest.fn().mockResolvedValue(undefined),
  } as unknown as Consumer;
  const kafka = {
    consumer: jest.fn().mockReturnValue(kafkaConsumer),
  } as unknown as Kafka;
  const commandBus = { execute: dispatch } as unknown as CommandBus;
  const configService = {
    get: jest.fn().mockReturnValue(KAFKA_CONFIG),
  } as unknown as ConfigService;
  const deadLetters = {
    recordMalformed: jest.fn().mockResolvedValue(undefined),
    recordRetriesExhausted: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConsumedMessageDeadLetterRepository;

  const consumer = new PaymentEventsConsumer(kafka, commandBus, configService, deadLetters);
  return { consumer, kafkaConsumer, deadLetters };
}

const EXPECTED_COMMIT = [{ topic: PAYMENT_PROCESSED_TOPIC, partition: 2, offset: '42' }];

describe('PaymentEventsConsumer.handleMessage', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('valid messages', () => {
    it('should dispatch ReactToPaymentOutcomeCommand and then commit offset + 1', async () => {
      const callOrder: string[] = [];
      const dispatch = jest.fn().mockImplementation(async () => {
        callOrder.push('dispatch');
      });
      const { consumer, kafkaConsumer } = buildConsumer(dispatch);
      (kafkaConsumer.commitOffsets as jest.Mock).mockImplementation(async () => {
        callOrder.push('commit');
      });

      await consumer.handleMessage(payloadFor(processedValue()));

      expect(dispatch).toHaveBeenCalledWith(
        new ReactToPaymentOutcomeCommand(PaymentOutcome.PROCESSED, {
          eventId: EVENT_ID,
          topic: PAYMENT_PROCESSED_TOPIC,
          orderId: ORDER_ID,
          paymentId: PAYMENT_ID,
        }),
      );
      expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
      expect(callOrder).toEqual(['dispatch', 'commit']);
    });

    it('should never pass the payment id (aggregateId) as the order id', async () => {
      const dispatch = jest.fn().mockResolvedValue(undefined);
      const { consumer } = buildConsumer(dispatch);

      await consumer.handleMessage(payloadFor(processedValue()));

      const command = dispatch.mock.calls[0][0] as ReactToPaymentOutcomeCommand;
      expect(command.inboundEvent.orderId).toBe(ORDER_ID);
      expect(command.inboundEvent.paymentId).toBe(PAYMENT_ID);
    });
  });

  describe('malformed messages', () => {
    it('should dead-letter a non-JSON message once, without retrying or dispatching, then commit', async () => {
      const dispatch = jest.fn();
      const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

      await consumer.handleMessage(payloadFor(Buffer.from('not json')));

      expect(dispatch).not.toHaveBeenCalled();
      expect(deadLetters.recordMalformed).toHaveBeenCalledTimes(1);
      expect(deadLetters.recordMalformed).toHaveBeenCalledWith(
        {
          topic: PAYMENT_PROCESSED_TOPIC,
          partition: 2,
          offset: '41',
          messageKey: PAYMENT_ID,
          rawValue: 'not json',
          eventId: undefined,
          orderId: undefined,
        },
        expect.any(Error),
      );
      expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
    });

    it('should keep the eventId and orderId it could read when dead-lettering', async () => {
      const { consumer, deadLetters } = buildConsumer();

      await consumer.handleMessage(payloadFor(processedValue({ version: 2 })));

      expect(deadLetters.recordMalformed).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID, orderId: ORDER_ID }),
        expect.any(Error),
      );
    });
  });

  describe('retryable failures', () => {
    it('should retry and succeed without dead-lettering when the failure is transient', async () => {
      const dispatch = jest
        .fn()
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue(undefined);
      const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

      await consumer.handleMessage(payloadFor(processedValue()));

      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
      expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
    });

    it('should dead-letter after maxAttempts failures and then commit', async () => {
      const notFound = new OrderNotFoundForPaymentError(ORDER_ID, PAYMENT_ID);
      const dispatch = jest.fn().mockRejectedValue(notFound);
      const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);

      await consumer.handleMessage(payloadFor(processedValue()));

      expect(dispatch).toHaveBeenCalledTimes(KAFKA_CONFIG.maxAttempts);
      expect(deadLetters.recordRetriesExhausted).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID, orderId: ORDER_ID, offset: '41' }),
        notFound,
        KAFKA_CONFIG.maxAttempts,
      );
      expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith(EXPECTED_COMMIT);
    });

    it('should log each retry with topic, partition, offset, eventId, orderId and attempt', async () => {
      const dispatch = jest
        .fn()
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue(undefined);
      const { consumer } = buildConsumer(dispatch);

      await consumer.handleMessage(payloadFor(processedValue()));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0][0] as string;
      for (const fragment of [
        PAYMENT_PROCESSED_TOPIC,
        'partition=2',
        'offset=41',
        EVENT_ID,
        ORDER_ID,
        'attempt 1/3',
      ]) {
        expect(message).toContain(fragment);
      }
    });

    it('should NOT commit and should propagate the error when the dead-letter write fails', async () => {
      const dispatch = jest.fn().mockRejectedValue(new Error('db down'));
      const { consumer, kafkaConsumer, deadLetters } = buildConsumer(dispatch);
      (deadLetters.recordRetriesExhausted as jest.Mock).mockRejectedValue(
        new Error('dead-letter table unavailable'),
      );

      await expect(consumer.handleMessage(payloadFor(processedValue()))).rejects.toThrow(
        'dead-letter table unavailable',
      );
      expect(kafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    });
  });
});
