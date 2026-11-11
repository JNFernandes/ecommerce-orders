import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from 'mongoose';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import {
  READ_MODEL_RECONNECT_DELAY_MS,
  ReadModelConnectionMonitor,
  observeReadModelConnection,
} from '../../../src/read-model/read-model-connection';

const URI = 'mongodb://localhost:27017/orders_read';

function fakeConnection(initial: Promise<unknown>): {
  connection: Connection;
  openUri: jest.Mock;
  state: { readyState: number };
} {
  const state = { readyState: 0 };
  const openUri = jest.fn();
  const connection = {
    on: jest.fn(),
    asPromise: jest.fn().mockReturnValue(initial),
    openUri,
    get readyState(): number {
      return state.readyState;
    },
  } as unknown as Connection;
  return { connection, openUri, state };
}

/** `null` simulates a missing read-model configuration. */
function config(uri: string | null = URI): ConfigService {
  return {
    get: jest.fn().mockReturnValue(uri === null ? undefined : { mongoUri: uri }),
  } as unknown as ConfigService;
}

function indexes(
  ensureIndexes: jest.Mock = jest.fn().mockResolvedValue(undefined),
): OrderViewRepository {
  return { ensureIndexes } as unknown as OrderViewRepository;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('observeReadModelConnection', () => {
  it('should observe error events and the initial connect so a failure cannot crash the process', async () => {
    const rejected = Promise.reject(new Error('ECONNREFUSED'));
    const { connection } = fakeConnection(rejected);

    expect(observeReadModelConnection(connection)).toBe(connection);
    expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    await expect(rejected).rejects.toThrow('ECONNREFUSED'); // handled, no unhandledRejection
  });
});

describe('ReadModelConnectionMonitor', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should log when the initial connection succeeds and not reconnect', async () => {
    const { connection, openUri } = fakeConnection(Promise.resolve());
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes());

    monitor.onApplicationBootstrap();
    await flush();
    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS * 2);

    expect(logSpy).toHaveBeenCalledWith('read model (MongoDB) connected');
    expect(openUri).not.toHaveBeenCalled();
  });

  it('should retry openUri after a failed initial connection until it succeeds', async () => {
    const { connection, openUri } = fakeConnection(Promise.reject(new Error('down')));
    openUri
      .mockReturnValueOnce(Promise.reject(new Error('still down')))
      .mockReturnValueOnce(Promise.resolve());
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes());

    monitor.onApplicationBootstrap();
    await flush();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS);
    await flush();
    expect(openUri).toHaveBeenCalledWith(URI);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS);
    await flush();
    expect(openUri).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith('read model (MongoDB) connected');
  });

  it('should skip reconnecting when the connection became ready in the meantime', async () => {
    const { connection, openUri, state } = fakeConnection(Promise.reject(new Error('down')));
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes());

    monitor.onApplicationBootstrap();
    await flush();
    state.readyState = 1;
    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS);

    expect(openUri).not.toHaveBeenCalled();
  });

  it('should stop retrying after application shutdown', async () => {
    const { connection, openUri } = fakeConnection(Promise.reject(new Error('down')));
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes());

    monitor.onApplicationBootstrap();
    await flush();
    monitor.onApplicationShutdown();
    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS * 3);

    expect(openUri).not.toHaveBeenCalled();
  });

  it('should not schedule a retry for a failure that settles after shutdown', async () => {
    let fail: (error: Error) => void = () => undefined;
    const pending = new Promise((_resolve, reject) => {
      fail = reject;
    });
    const { connection, openUri } = fakeConnection(pending);
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes());

    monitor.onApplicationBootstrap();
    monitor.onApplicationShutdown();
    fail(new Error('down'));
    await flush();
    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS * 2);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(openUri).not.toHaveBeenCalled();
  });

  it('should log an error and give up when MONGO_URI is missing', async () => {
    const { connection, openUri } = fakeConnection(Promise.reject(new Error('down')));
    const monitor = new ReadModelConnectionMonitor(connection, config(null), indexes());

    monitor.onApplicationBootstrap();
    await flush();
    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS);

    expect(openUri).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ReadModelConnectionMonitor — indexes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should ensure the read-model indexes once the initial connection succeeds', async () => {
    const { connection } = fakeConnection(Promise.resolve());
    const ensureIndexes = jest.fn().mockResolvedValue(undefined);
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes(ensureIndexes));

    monitor.onApplicationBootstrap();
    await flush();

    expect(ensureIndexes).toHaveBeenCalledTimes(1);
  });

  it('should ensure the indexes after a reconnect following a failed initial connection', async () => {
    const { connection, openUri } = fakeConnection(Promise.reject(new Error('down')));
    openUri.mockReturnValueOnce(Promise.resolve());
    const ensureIndexes = jest.fn().mockResolvedValue(undefined);
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes(ensureIndexes));

    monitor.onApplicationBootstrap();
    await flush();
    expect(ensureIndexes).not.toHaveBeenCalled();

    jest.advanceTimersByTime(READ_MODEL_RECONNECT_DELAY_MS);
    await flush();
    await flush();

    expect(ensureIndexes).toHaveBeenCalledTimes(1);
  });

  it('should log a warning and keep running when creating the indexes fails', async () => {
    const { connection } = fakeConnection(Promise.resolve());
    const ensureIndexes = jest.fn().mockRejectedValue(new Error('not authorized'));
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const monitor = new ReadModelConnectionMonitor(connection, config(), indexes(ensureIndexes));

    monitor.onApplicationBootstrap();
    await flush();
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not authorized'));
  });
});
