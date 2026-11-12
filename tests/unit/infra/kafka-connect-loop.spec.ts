import { Logger } from '@nestjs/common';
import { KafkaConnectLoop } from '../../../src/infra/kafka/kafka-connect-loop';

/** Lets pending promise callbacks run without advancing fake time. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('KafkaConnectLoop', () => {
  let logger: Logger;
  let connect: jest.Mock;
  let loop: KafkaConnectLoop;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = new Logger('test');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    connect = jest.fn().mockResolvedValue(undefined);
    loop = new KafkaConnectLoop({
      name: 'test consumer',
      connect,
      initialMs: 1_000,
      maxMs: 4_000,
      logger,
      random: (): number => 0.5, // no jitter
    });
  });

  afterEach(async () => {
    await loop.stop();
    jest.useRealTimers();
  });

  it('should return from start() at once and connect in the background', async () => {
    let finish: () => void = () => undefined;
    connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    expect(loop.start()).toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should retry a failed connect with capped exponential backoff, one log line per attempt', async () => {
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);

    loop.start();
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); // 1 s
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2_000); // 2 s
    expect(connect).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4_000); // 4 s
    expect(connect).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(4_000); // capped at 4 s
    expect(connect).toHaveBeenCalledTimes(5);

    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /test consumer: Kafka is unreachable .*ECONNREFUSED.*retrying in 1000ms/,
      ),
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('test consumer: Kafka is available again'),
    );

    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it('should stop retrying when stopped while waiting, and resolve stop() promptly', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    loop.start();
    await flush();

    await loop.stop();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should wait for an attempt in flight when stopped, and not start another', async () => {
    let fail: (error: Error) => void = () => undefined;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    loop.start();

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    fail(new Error('ECONNREFUSED'));
    await stopping;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('should be safe to stop when never started', async () => {
    await expect(loop.stop()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });
});
