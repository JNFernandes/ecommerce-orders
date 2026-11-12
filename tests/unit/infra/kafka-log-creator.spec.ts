import { Logger } from '@nestjs/common';
import { LogEntry, logLevel } from 'kafkajs';
import { createKafkaLogCreator } from '../../../src/infra/kafka/kafka-log-creator';

function entry(
  level: logLevel,
  namespace: string,
  message: string,
  extra: Record<string, unknown> = {},
): LogEntry {
  return {
    level,
    namespace,
    label: logLevel[level],
    log: { timestamp: '2026-11-12T16:00:00.000Z', logger: 'kafkajs', message, ...extra },
  };
}

describe('createKafkaLogCreator', () => {
  let logger: Logger;
  let now: number;
  let write: (entry: LogEntry) => void;

  beforeEach(() => {
    logger = new Logger('kafkajs');
    for (const level of ['error', 'warn', 'log', 'debug'] as const) {
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    }
    now = 0;
    write = createKafkaLogCreator(logger, 60_000, (): number => now)(logLevel.INFO);
  });

  it('should forward kafkajs entries to the Nest logger at the matching level, with context', () => {
    write(
      entry(logLevel.ERROR, 'Consumer', 'Crash: KafkaJSNumberOfRetriesExceeded', { groupId: 'g' }),
    );
    write(entry(logLevel.WARN, 'Producer', 'partitioner warning'));
    write(entry(logLevel.INFO, 'Consumer', 'Consumer has joined the group'));
    write(entry(logLevel.DEBUG, 'Connection', 'Request Metadata'));

    expect(logger.error).toHaveBeenCalledWith(
      '[Consumer] Crash: KafkaJSNumberOfRetriesExceeded {"groupId":"g"}',
    );
    expect(logger.warn).toHaveBeenCalledWith('[Producer] partitioner warning');
    expect(logger.log).toHaveBeenCalledWith('[Consumer] Consumer has joined the group');
    expect(logger.debug).toHaveBeenCalledWith('[Connection] Request Metadata');
  });

  it('should omit the namespace when kafkajs gives none', () => {
    write({
      ...entry(logLevel.WARN, '', 'partitioner notice'),
      namespace: undefined as unknown as string,
    });

    expect(logger.warn).toHaveBeenCalledWith('partitioner notice');
  });

  it('should log a repeated connection failure once per window, as a warning', () => {
    const failure = entry(logLevel.ERROR, 'Connection', 'Connection timeout', {
      broker: '10.0.0.1:9092',
    });
    const seed = entry(
      logLevel.ERROR,
      'BrokerPool',
      'Failed to connect to seed broker, trying another broker from the list: Connection timeout',
      { retryCount: 0 },
    );

    for (let i = 0; i < 10; i++) {
      write(failure);
      write({ ...seed, log: { ...seed.log, retryCount: i } });
      now += 1_000;
    }

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Connection] Connection timeout'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('(repeats are suppressed for 60s)'),
    );

    now += 60_000;
    write(failure);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('should throttle each broker separately', () => {
    write(entry(logLevel.ERROR, 'Connection', 'Connection error: ECONNREFUSED', { broker: 'a:1' }));
    write(entry(logLevel.ERROR, 'Connection', 'Connection error: ECONNREFUSED', { broker: 'b:1' }));
    write(entry(logLevel.ERROR, 'Connection', 'Connection error: ECONNREFUSED', { broker: 'a:1' }));

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
