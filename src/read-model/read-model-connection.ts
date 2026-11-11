import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ReadModelConfig } from '../config/configuration';

/** Delay between attempts to (re)establish the initial MongoDB connection. */
export const READ_MODEL_RECONNECT_DELAY_MS = 5_000;

/**
 * Makes a lazily-created connection safe to leave unconnected: the initial connect promise and
 * `error` events are observed so a MongoDB outage never crashes the process. Passed to
 * MongooseModule as `connectionFactory` (with `lazyConnection`, `onConnectionCreate` is not
 * invoked, so this is the only hook that runs before the first connection attempt fails).
 */
export function observeReadModelConnection(connection: Connection): Connection {
  connection.on('error', () => undefined); // logged by ReadModelConnectionMonitor
  connection.asPromise().catch(() => undefined);
  return connection;
}

/**
 * Keeps trying to establish the read-model connection until it succeeds. Mongoose never retries
 * a failed *initial* connection on its own (once connected, the driver handles reconnects), so
 * without this a cold start with MongoDB down would leave the projection broken until restart.
 */
@Injectable()
export class ReadModelConnectionMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReadModelConnectionMonitor.name);
  private readonly reconnectDelayMs = READ_MODEL_RECONNECT_DELAY_MS;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.watch(this.connection.asPromise());
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private watch(attempt: Promise<unknown>): void {
    attempt.then(
      () => this.logger.log('read model (MongoDB) connected'),
      (error: unknown) => {
        if (this.stopped) {
          return;
        }
        this.logger.warn(
          `read model (MongoDB) unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            `retrying in ${this.reconnectDelayMs}ms`,
        );
        this.timer = setTimeout(() => this.reconnect(), this.reconnectDelayMs);
        this.timer.unref();
      },
    );
  }

  private reconnect(): void {
    if (this.stopped || this.connection.readyState === 1) {
      return;
    }
    const uri = this.configService.get<ReadModelConfig>('readModel')?.mongoUri;
    if (!uri) {
      this.logger.error('MONGO_URI is not configured; not reconnecting');
      return;
    }
    this.watch(this.connection.openUri(uri));
  }
}
