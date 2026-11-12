import { DeadLetterStatus } from '../database/entities/dead-letter-status.enum';

/** Backoff and limit settings for dead-letter retries. */
export interface RetrySettings {
  /** Delay before the first retry, doubled on each later retry. */
  baseDelayMs: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
  /** Worker attempts after which a row is marked EXHAUSTED. */
  maxRetries: number;
}

/** Outcome of one retry attempt, as classified by the worker. */
export type AttemptResult =
  { kind: 'success' } | { kind: 'permanent'; error: string } | { kind: 'transient'; error: string };

/** The bookkeeping columns to write back on a dead-letter row after an attempt. */
export interface RetryUpdate {
  status: DeadLetterStatus;
  retryCount: number;
  nextRetryAt: Date;
  lastAttemptAt: Date;
  lastError: string | null;
  resolvedAt: Date | null;
}

/**
 * Delay before the next attempt after the `retryCount`-th failure:
 * `min(base × 2^(retryCount − 1), max)`.
 */
export function deadLetterDelay(retryCount: number, settings: RetrySettings): number {
  const exponent = Math.max(retryCount - 1, 0);
  // Cap the exponent so very large counts cannot overflow to Infinity before the min().
  const raw = settings.baseDelayMs * 2 ** Math.min(exponent, 52);
  return Math.min(raw, settings.maxDelayMs);
}

/**
 * Decides the next state of a dead-letter row after one attempt. Pure: the clock is passed in.
 * `nextRetryAt` only moves forward when the row is rescheduled.
 */
export function decideRetry(
  row: { retryCount: number; nextRetryAt: Date },
  result: AttemptResult,
  now: Date,
  settings: RetrySettings,
): RetryUpdate {
  const retryCount = row.retryCount + 1;
  const base = { retryCount, lastAttemptAt: now, nextRetryAt: row.nextRetryAt };

  if (result.kind === 'success') {
    return { ...base, status: DeadLetterStatus.RESOLVED, lastError: null, resolvedAt: now };
  }
  if (result.kind === 'permanent' || retryCount >= settings.maxRetries) {
    return {
      ...base,
      status: DeadLetterStatus.EXHAUSTED,
      lastError: result.error,
      resolvedAt: null,
    };
  }
  return {
    ...base,
    status: DeadLetterStatus.PENDING_RETRY,
    nextRetryAt: new Date(now.getTime() + deadLetterDelay(retryCount, settings)),
    lastError: result.error,
    resolvedAt: null,
  };
}
