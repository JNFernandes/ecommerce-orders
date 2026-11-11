import { Logger } from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import {
  ConsumeWithDeadLetterOptions,
  consumeWithDeadLetter,
} from '../../../src/infra/kafka/consume-with-dead-letter';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';

const EVENT_ID = '9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3';
const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

class OutageError extends Error {}

interface Parsed {
  eventId: string;
  orderId: string;
}

function payload(value: string | null = '{"ok":true}'): EachMessagePayload {
  return {
    topic: 'some.topic',
    partition: 2,
    message: {
      key: Buffer.from('key-1'),
      value: value === null ? null : Buffer.from(value),
      timestamp: '0',
      attributes: 0,
      offset: '41',
      headers: {},
    },
    heartbeat: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  } as unknown as EachMessagePayload;
}

function setup(overrides: Partial<ConsumeWithDeadLetterOptions<Parsed>> = {}): {
  options: ConsumeWithDeadLetterOptions<Parsed>;
  deadLetters: ConsumedMessageDeadLetterRepository;
  commit: jest.Mock;
  handle: jest.Mock;
  logger: Logger;
} {
  const deadLetters = {
    recordMalformed: jest.fn().mockResolvedValue(undefined),
    recordRetriesExhausted: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConsumedMessageDeadLetterRepository;
  const commit = jest.fn().mockResolvedValue(undefined);
  const handle = jest.fn().mockResolvedValue(undefined);
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;
  const options: ConsumeWithDeadLetterOptions<Parsed> = {
    parse: () => ({ eventId: EVENT_ID, orderId: ORDER_ID }),
    describe: (parsed) => ({ eventId: parsed.eventId, orderId: parsed.orderId }),
    handle,
    deadLetters,
    retry: { maxAttempts: 3, initialMs: 1, maxMs: 2 },
    commit,
    logger,
    ...overrides,
  };
  return { options, deadLetters, commit, handle, logger };
}

const BASE_META = {
  topic: 'some.topic',
  partition: 2,
  offset: '41',
  messageKey: 'key-1',
  rawValue: '{"ok":true}',
};

describe('consumeWithDeadLetter', () => {
  it('should handle the parsed message and then commit', async () => {
    const { options, commit, handle, deadLetters } = setup();
    const order: string[] = [];
    handle.mockImplementation(async () => order.push('handle'));
    commit.mockImplementation(async () => order.push('commit'));

    await consumeWithDeadLetter(payload(), options);

    expect(handle).toHaveBeenCalledWith({ eventId: EVENT_ID, orderId: ORDER_ID });
    expect(order).toEqual(['handle', 'commit']);
    expect(deadLetters.recordMalformed).not.toHaveBeenCalled();
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
  });

  it('should dead-letter a malformed message once with the ids it could read, then commit', async () => {
    const malformed = new MalformedMessageError('bad payload', EVENT_ID, ORDER_ID);
    const { options, commit, handle, deadLetters } = setup({
      parse: () => {
        throw malformed;
      },
    });

    await consumeWithDeadLetter(payload('not json'), options);

    expect(handle).not.toHaveBeenCalled();
    expect(deadLetters.recordMalformed).toHaveBeenCalledWith(
      { ...BASE_META, rawValue: 'not json', eventId: EVENT_ID, orderId: ORDER_ID },
      malformed,
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('should rethrow a non-malformed error thrown by parse, without committing', async () => {
    const { options, commit } = setup({
      parse: () => {
        throw new TypeError('bug');
      },
    });

    await expect(consumeWithDeadLetter(payload(), options)).rejects.toThrow('bug');
    expect(commit).not.toHaveBeenCalled();
  });

  it('should retry a transient failure and commit without dead-lettering', async () => {
    const { options, commit, handle, deadLetters } = setup();
    handle.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);

    await consumeWithDeadLetter(payload(), options);

    expect(handle).toHaveBeenCalledTimes(2);
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('should dead-letter after maxAttempts failures, then commit', async () => {
    const boom = new Error('boom');
    const { options, commit, handle, deadLetters } = setup();
    handle.mockRejectedValue(boom);

    await consumeWithDeadLetter(payload(), options);

    expect(handle).toHaveBeenCalledTimes(3);
    expect(deadLetters.recordRetriesExhausted).toHaveBeenCalledWith(
      { ...BASE_META, eventId: EVENT_ID, orderId: ORDER_ID },
      boom,
      3,
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('should rethrow a fatal error after retries, without dead-lettering or committing', async () => {
    const outage = new OutageError('mongo down');
    const { options, commit, handle, deadLetters, logger } = setup({
      isFatal: (error) => error instanceof OutageError,
    });
    handle.mockRejectedValue(outage);

    await expect(consumeWithDeadLetter(payload(), options)).rejects.toBe(outage);

    expect(handle).toHaveBeenCalledTimes(3);
    expect(deadLetters.recordRetriesExhausted).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('should not commit and should rethrow when the dead-letter write fails', async () => {
    const { options, commit, handle, deadLetters } = setup();
    handle.mockRejectedValue(new Error('boom'));
    (deadLetters.recordRetriesExhausted as jest.Mock).mockRejectedValue(new Error('pg down'));

    await expect(consumeWithDeadLetter(payload(), options)).rejects.toThrow('pg down');
    expect(commit).not.toHaveBeenCalled();
  });

  it('should log each retry with topic, partition, offset, eventId, orderId and attempt', async () => {
    const { options, handle, logger } = setup();
    handle.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);

    await consumeWithDeadLetter(payload(), options);

    const message = (logger.warn as jest.Mock).mock.calls[0][0] as string;
    for (const fragment of [
      'some.topic',
      'partition=2',
      'offset=41',
      EVENT_ID,
      ORDER_ID,
      'attempt 1/3',
    ]) {
      expect(message).toContain(fragment);
    }
  });
});
