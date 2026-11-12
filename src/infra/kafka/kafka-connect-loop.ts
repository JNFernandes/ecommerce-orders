import { Logger } from '@nestjs/common';
import { retryWithBackoff } from './retry-with-backoff';

/** Options for KafkaConnectLoop. */
export interface KafkaConnectLoopOptions {
  /** Who is connecting, for logs (e.g. "payment events consumer"). */
  name: string;
  /**
   * One attempt: connect, subscribe and run. It must leave the client disconnected when it
   * throws, so the next attempt starts clean.
   */
  connect: () => Promise<void>;
  /** Delay before the second attempt. */
  initialMs: number;
  /** Cap on any delay. */
  maxMs: number;
  /** The owner's logger. */
  logger: Logger;
  /** Random source for jitter (injectable for tests). */
  random?: () => number;
}

/** Internal signal that the loop was stopped; never retried and never logged. */
class LoopStoppedError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connects a Kafka consumer in the background, retrying with capped exponential backoff
 * (`retryWithBackoff`) until it succeeds or `stop()` is called. Application startup never waits
 * for it, so the service starts while Kafka is down.
 *
 * Logs one warning per failed attempt ("Kafka is unreachable"), and one line once it connects
 * after failures ("Kafka is available again").
 */
export class KafkaConnectLoop {
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: KafkaConnectLoopOptions) {}

  /** Starts connecting in the background and returns immediately. */
  start(): void {
    if (this.running !== null || this.stopping) {
      return;
    }
    const { name, logger } = this.options;
    this.running = retryWithBackoff(
      async (attempt) => {
        if (this.stopping) {
          throw new LoopStoppedError();
        }
        await this.options.connect();
        return attempt;
      },
      {
        maxAttempts: Number.POSITIVE_INFINITY,
        initialMs: this.options.initialMs,
        maxMs: this.options.maxMs,
        isRetryable: (error) => !(error instanceof LoopStoppedError) && !this.stopping,
        onRetry: (attempt, error, delayMs) =>
          logger.warn(
            `${name}: Kafka is unreachable (attempt ${attempt}: ${messageOf(error)}); ` +
              `retrying in ${delayMs}ms`,
          ),
        random: this.options.random,
        sleep: (ms) => this.sleep(ms),
      },
    ).then(
      (attempts) => {
        if (attempts > 1) {
          logger.log(`${name}: Kafka is available again, connected after ${attempts} attempts`);
        }
      },
      (error: unknown) => {
        if (!this.stopping && !(error instanceof LoopStoppedError)) {
          logger.error(`${name}: gave up connecting to Kafka: ${messageOf(error)}`);
        }
      },
    );
  }

  /** Stops retrying, interrupting any wait, and waits for an attempt still in flight. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  /** A wait that `stop()` cuts short. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wake = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
