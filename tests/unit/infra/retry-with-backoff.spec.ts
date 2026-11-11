import {
  RetriesExhaustedError,
  backoffDelay,
  retryWithBackoff,
} from '../../../src/infra/kafka/retry-with-backoff';

class PermanentError extends Error {}

interface TestOptions {
  maxAttempts: number;
  initialMs: number;
  maxMs: number;
  isRetryable: (error: unknown) => boolean;
  random: () => number;
  sleep: jest.Mock;
  heartbeat: jest.Mock;
  onRetry: jest.Mock;
}

function options(overrides: Partial<TestOptions> = {}): TestOptions {
  return {
    maxAttempts: 5,
    initialMs: 1000,
    maxMs: 30_000,
    isRetryable: (error: unknown) => !(error instanceof PermanentError),
    random: () => 0.5, // no jitter
    sleep: jest.fn().mockResolvedValue(undefined),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    onRetry: jest.fn(),
    ...overrides,
  };
}

describe('backoffDelay', () => {
  it('should double the delay on each attempt', () => {
    const noJitter = (): number => 0.5;
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, 1000, 30_000, noJitter))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('should cap the delay at maxMs', () => {
    expect(backoffDelay(10, 1000, 30_000, () => 0.5)).toBe(30_000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it('should apply at most ±20% jitter', () => {
    expect(backoffDelay(2, 1000, 30_000, () => 0)).toBe(1600);
    expect(backoffDelay(2, 1000, 30_000, () => 1)).toBe(2400);
  });
});

describe('retryWithBackoff', () => {
  it('should return the result on the first success without waiting', async () => {
    const opts = options();
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(retryWithBackoff(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('should retry a retryable error with exponential delays and succeed', async () => {
    const opts = options();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValue('ok');

    await expect(retryWithBackoff(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(opts.onRetry.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      [1, 1000],
      [2, 2000],
    ]);
    expect(opts.onRetry.mock.calls[0][1]).toEqual(new Error('transient 1'));
  });

  it('should throw RetriesExhaustedError with the last error after maxAttempts', async () => {
    const opts = options({ maxAttempts: 3 });
    const lastError = new Error('still down');
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(lastError);

    const error = await retryWithBackoff(fn, opts).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect((error as RetriesExhaustedError).attempts).toBe(3);
    expect((error as RetriesExhaustedError).lastError).toBe(lastError);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(opts.onRetry).toHaveBeenCalledTimes(2);
  });

  it('should rethrow a non-retryable error immediately without waiting', async () => {
    const opts = options();
    const permanent = new PermanentError('bad input');
    const fn = jest.fn().mockRejectedValue(permanent);

    await expect(retryWithBackoff(fn, opts)).rejects.toBe(permanent);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('should send a heartbeat at least every 3 seconds during a long wait', async () => {
    const opts = options({ initialMs: 8000 });
    const fn = jest.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('ok');

    await retryWithBackoff(fn, opts);

    const chunks = opts.sleep.mock.calls.map((call) => call[0] as number);
    expect(chunks.reduce((sum, ms) => sum + ms, 0)).toBe(8000);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(3000);
    expect(opts.heartbeat).toHaveBeenCalledTimes(chunks.length);
  });
});
