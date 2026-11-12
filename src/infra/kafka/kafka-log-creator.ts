import { Logger } from '@nestjs/common';
import { LogEntry, logCreator, logLevel } from 'kafkajs';

/** How long repeats of the same connection failure are suppressed by default. */
export const CONNECTION_FAILURE_LOG_WINDOW_MS = 60_000;

/**
 * kafkajs logs every internal connection retry (`[Connection] Connection timeout`,
 * `[BrokerPool] Failed to connect to seed broker …`), so an outage prints several lines per
 * second. Those are the only entries throttled; our own code already logs one line per attempt
 * ("Kafka is unreachable" / "Kafka is available again").
 */
function connectionFailureKey(entry: LogEntry): string | null {
  const { namespace, log } = entry;
  const broker = typeof log.broker === 'string' ? log.broker : '';
  if (namespace === 'Connection' && /^Connection (timeout|error)/.test(log.message)) {
    return `${namespace}|${broker}|${log.message}`;
  }
  if (namespace === 'BrokerPool' && log.message.startsWith('Failed to connect to seed broker')) {
    return `${namespace}|${log.message}`;
  }
  return null;
}

function format(entry: LogEntry): string {
  const extra: Record<string, unknown> = { ...entry.log };
  delete extra.timestamp;
  delete extra.logger;
  delete extra.message;
  const message = entry.log.message;
  const context = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  const namespace = entry.namespace ? `[${entry.namespace}] ` : '';
  return `${namespace}${message}${context}`;
}

/**
 * A kafkajs `logCreator` that writes through the Nest logger (one line per entry, at the same
 * level) instead of kafkajs's raw JSON. Repeated connection failures are logged once per
 * `windowMs` per broker and message, as a warning.
 */
export function createKafkaLogCreator(
  logger: Logger = new Logger('kafkajs'),
  windowMs: number = CONNECTION_FAILURE_LOG_WINDOW_MS,
  now: () => number = Date.now,
): logCreator {
  const lastLogged = new Map<string, number>();
  return () => (entry: LogEntry) => {
    const key = connectionFailureKey(entry);
    if (key !== null) {
      const previous = lastLogged.get(key);
      if (previous !== undefined && now() - previous < windowMs) {
        return;
      }
      lastLogged.set(key, now());
      logger.warn(`${format(entry)} (repeats are suppressed for ${windowMs / 1000}s)`);
      return;
    }
    switch (entry.level) {
      case logLevel.ERROR:
      case logLevel.NOTHING:
        logger.error(format(entry));
        break;
      case logLevel.WARN:
        logger.warn(format(entry));
        break;
      case logLevel.INFO:
        logger.log(format(entry));
        break;
      default:
        logger.debug(format(entry));
    }
  };
}
