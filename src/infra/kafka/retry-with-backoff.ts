/** Longest single wait between heartbeats, kept well under kafkajs's default 30s session timeout. */
const MAX_WAIT_BETWEEN_HEARTBEATS_MS = 3_000;
const JITTER_RATIO = 0.2;

/** Options for retryWithBackoff. */
export interface RetryWithBackoffOptions {
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Delay before the second attempt. */
  initialMs: number;
  /** Upper bound for any delay. */
  maxMs: number;
  /** False for errors that must not be retried (they are rethrown immediately). */
  isRetryable: (error: unknown) => boolean;
  /** Called while waiting, at least every 3s (e.g. the kafkajs `heartbeat`). */
  heartbeat?: () => Promise<void>;
  /** Called before each wait with the failed attempt number, its error and the delay. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Random source in [0, 1) for jitter (injectable for tests). */
  random?: () => number;
  /** Sleep function (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when every attempt failed with a retryable error. */
export class RetriesExhaustedError extends Error {
  constructor(
    /** Number of attempts made. */
    public readonly attempts: number,
    /** The error from the last attempt. */
    public readonly lastError: unknown,
  ) {
    super(
      `gave up after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = 'RetriesExhaustedError';
  }
}

/**
 * Delay before retrying after failed attempt `attempt` (1-based):
 * `min(initialMs × 2^(attempt-1), maxMs)` with ±20% jitter, never above `maxMs`.
 */
export function backoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(initialMs * 2 ** (attempt - 1), maxMs);
  const jitter = base * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.min(maxMs, Math.round(base + jitter)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` until it succeeds, retrying retryable errors with exponential backoff.
 *
 * @throws the original error, immediately, if it is not retryable.
 * @throws RetriesExhaustedError once `maxAttempts` attempts have failed.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!options.isRetryable(error)) {
        throw error;
      }
      if (attempt >= options.maxAttempts) {
        throw new RetriesExhaustedError(attempt, error);
      }

      const delayMs = backoffDelay(attempt, options.initialMs, options.maxMs, options.random);
      options.onRetry?.(attempt, error, delayMs);

      let remaining = delayMs;
      while (remaining > 0) {
        const chunk = Math.min(remaining, MAX_WAIT_BETWEEN_HEARTBEATS_MS);
        await sleep(chunk);
        remaining -= chunk;
        await options.heartbeat?.();
      }
    }
  }
}
