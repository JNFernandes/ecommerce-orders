import {
  RetrySettings,
  deadLetterDelay,
  decideRetry,
} from '../../../src/infra/dead-letter/retry-policy';
import { DeadLetterStatus } from '../../../src/infra/database/entities/dead-letter-status.enum';

const SETTINGS: RetrySettings = { baseDelayMs: 5_000, maxDelayMs: 600_000, maxRetries: 8 };
const NOW = new Date('2026-11-12T12:00:00.000Z');
const PREVIOUS_DUE = new Date('2026-11-12T11:59:00.000Z');

function row(retryCount: number): { retryCount: number; nextRetryAt: Date } {
  return { retryCount, nextRetryAt: PREVIOUS_DUE };
}

function plus(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe('deadLetterDelay', () => {
  it('should double from the base delay on each retry and stop at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => deadLetterDelay(n, SETTINGS))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000,
    ]);
  });

  it('should never exceed a lower cap', () => {
    expect(deadLetterDelay(4, { ...SETTINGS, maxDelayMs: 30_000 })).toBe(30_000);
    expect(deadLetterDelay(30, { ...SETTINGS, maxDelayMs: 30_000 })).toBe(30_000);
  });
});

describe('decideRetry', () => {
  it('should resolve a successful attempt', () => {
    expect(decideRetry(row(2), { kind: 'success' }, NOW, SETTINGS)).toEqual({
      status: DeadLetterStatus.RESOLVED,
      retryCount: 3,
      nextRetryAt: PREVIOUS_DUE,
      lastAttemptAt: NOW,
      lastError: null,
      resolvedAt: NOW,
    });
  });

  it('should exhaust a permanent failure immediately, whatever the retry count', () => {
    expect(decideRetry(row(0), { kind: 'permanent', error: 'not JSON' }, NOW, SETTINGS)).toEqual({
      status: DeadLetterStatus.EXHAUSTED,
      retryCount: 1,
      nextRetryAt: PREVIOUS_DUE,
      lastAttemptAt: NOW,
      lastError: 'not JSON',
      resolvedAt: null,
    });
  });

  it('should reschedule the first transient failure after the base delay', () => {
    expect(decideRetry(row(0), { kind: 'transient', error: 'broker down' }, NOW, SETTINGS)).toEqual(
      {
        status: DeadLetterStatus.PENDING_RETRY,
        retryCount: 1,
        nextRetryAt: plus(5_000),
        lastAttemptAt: NOW,
        lastError: 'broker down',
        resolvedAt: null,
      },
    );
  });

  it('should reschedule the 7th transient failure after 320 s', () => {
    const update = decideRetry(row(6), { kind: 'transient', error: 'x' }, NOW, SETTINGS);

    expect(update.status).toBe(DeadLetterStatus.PENDING_RETRY);
    expect(update.retryCount).toBe(7);
    expect(update.nextRetryAt).toEqual(plus(320_000));
  });

  it('should exhaust when a transient failure reaches the maximum number of retries', () => {
    const update = decideRetry(row(7), { kind: 'transient', error: 'still down' }, NOW, SETTINGS);

    expect(update).toEqual({
      status: DeadLetterStatus.EXHAUSTED,
      retryCount: 8,
      nextRetryAt: PREVIOUS_DUE,
      lastAttemptAt: NOW,
      lastError: 'still down',
      resolvedAt: null,
    });
  });
});
