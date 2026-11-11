import { Logger } from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import {
  ConsumedMessageDeadLetterRepository,
  ConsumedMessageMeta,
} from '../../repositories/consumed-message-dead-letter.repository';
import { MalformedMessageError } from './malformed-message.error';
import { RetriesExhaustedError, retryWithBackoff } from './retry-with-backoff';

/** Options for consumeWithDeadLetter. */
export interface ConsumeWithDeadLetterOptions<T> {
  /** Parses and validates the raw value; throws MalformedMessageError for poison messages. */
  parse: (topic: string, value: Buffer | null) => T;
  /** Identifiers of a parsed message, for logs and dead-letter rows. */
  describe: (parsed: T) => { eventId?: string; orderId?: string };
  /** Applies the message (dispatches a command, projects an event, …). */
  handle: (parsed: T) => Promise<unknown>;
  /**
   * Errors that must NOT be dead-lettered once retries run out (e.g. the target store is
   * unreachable): they are rethrown so the offset stays uncommitted and the message is
   * redelivered. Defaults to none.
   */
  isFatal?: (error: unknown) => boolean;
  /** Where unprocessable messages are recorded. */
  deadLetters: ConsumedMessageDeadLetterRepository;
  /** Backoff settings. */
  retry: { maxAttempts: number; initialMs: number; maxMs: number };
  /** Commits `offset + 1` for this message. */
  commit: () => Promise<void>;
  /** The consumer's logger. */
  logger: Logger;
}

/**
 * Shared flow for every Kafka consumer in this service:
 *
 * 1. parse → MalformedMessageError ⇒ dead-letter (`MALFORMED`, no retry) and commit;
 * 2. handle with exponential backoff (heartbeating while waiting);
 * 3. retries exhausted ⇒ fatal error: rethrow (no dead letter, no commit, redelivered);
 *    otherwise dead-letter (`RETRIES_EXHAUSTED`) and commit;
 * 4. success ⇒ commit.
 *
 * The offset is only committed once the outcome (handled, or dead-letter row saved) is durable.
 * If writing the dead letter fails, the error propagates and nothing is committed.
 */
export async function consumeWithDeadLetter<T>(
  payload: EachMessagePayload,
  options: ConsumeWithDeadLetterOptions<T>,
): Promise<void> {
  const { topic, partition, message } = payload;
  const { logger, deadLetters } = options;
  const meta: ConsumedMessageMeta = {
    topic,
    partition,
    offset: message.offset,
    messageKey: message.key?.toString('utf8') ?? null,
    rawValue: message.value?.toString('utf8') ?? null,
  };

  let parsed: T;
  try {
    parsed = options.parse(topic, message.value);
  } catch (error) {
    if (!(error instanceof MalformedMessageError)) {
      throw error;
    }
    const malformed = { ...meta, eventId: error.eventId, orderId: error.orderId };
    await deadLetters.recordMalformed(malformed, error);
    logger.warn(`dead-lettered malformed message (${error.message}); ${describe(malformed)}`);
    await options.commit();
    return;
  }

  const identified: ConsumedMessageMeta = { ...meta, ...options.describe(parsed) };
  try {
    await retryWithBackoff(() => options.handle(parsed), {
      maxAttempts: options.retry.maxAttempts,
      initialMs: options.retry.initialMs,
      maxMs: options.retry.maxMs,
      isRetryable: (error) => !(error instanceof MalformedMessageError),
      heartbeat: payload.heartbeat,
      onRetry: (attempt, error, delayMs) =>
        logger.warn(
          `attempt ${attempt}/${options.retry.maxAttempts} failed (${messageOf(error)}), ` +
            `retrying in ${delayMs}ms; ${describe(identified)}`,
        ),
    });
  } catch (error) {
    if (!(error instanceof RetriesExhaustedError)) {
      throw error;
    }
    if (options.isFatal?.(error.lastError)) {
      logger.error(
        `giving up for now after ${error.attempts} attempts (${messageOf(error.lastError)}); ` +
          `not committing, message will be redelivered; ${describe(identified)}`,
      );
      throw error.lastError;
    }
    await deadLetters.recordRetriesExhausted(identified, error.lastError, error.attempts);
    logger.error(
      `dead-lettered after ${error.attempts} attempts (${messageOf(error.lastError)}); ` +
        describe(identified),
    );
  }

  await options.commit();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(meta: ConsumedMessageMeta): string {
  return (
    `topic=${meta.topic} partition=${meta.partition} offset=${meta.offset} ` +
    `eventId=${meta.eventId ?? '-'} orderId=${meta.orderId ?? '-'}`
  );
}
