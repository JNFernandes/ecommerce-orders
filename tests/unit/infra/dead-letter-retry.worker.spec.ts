import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeadLetterConfig } from '../../../src/config/configuration';
import { DeadLetterRetryWorker } from '../../../src/infra/dead-letter/dead-letter-retry.worker';
import { RetryUpdate } from '../../../src/infra/dead-letter/retry-policy';
import { DeadLetterStatus } from '../../../src/infra/database/entities/dead-letter-status.enum';
import { OrderDeadLetterEntity } from '../../../src/infra/database/entities/order-dead-letter.entity';
import { OrderDeadLetterRepository } from '../../../src/repositories/order-dead-letter.repository';
import { OrderEventsProducer } from '../../../src/infra/kafka/order-events.producer';
import {
  ConsumedMessageDeadLetterEntity,
  ConsumedMessageFailureType,
} from '../../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { ConsumedMessageDeadLetterRepository } from '../../../src/repositories/consumed-message-dead-letter.repository';
import { PaymentEventsConsumer } from '../../../src/infra/kafka/payment-events.consumer';
import { OrderProjectionConsumer } from '../../../src/infra/kafka/order-projection.consumer';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';

const SETTINGS: DeadLetterConfig = {
  enabled: true,
  intervalMs: 1_000,
  batchSize: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 600_000,
  maxRetries: 8,
};
const NOW = new Date('2026-11-12T12:00:00.000Z');

type Handler<T> = (row: T) => Promise<RetryUpdate>;

/** A fake repository: hands out queued rows and records the updates the handler returns. */
class FakeStore<T> {
  readonly queue: T[] = [];
  readonly updates: RetryUpdate[] = [];
  readonly processNextDue = jest.fn(async (handler: Handler<T>): Promise<boolean> => {
    const row = this.queue.shift();
    if (row === undefined) {
      return false;
    }
    this.updates.push(await handler(row));
    return true;
  });
}

function outboundRow(overrides: Partial<OrderDeadLetterEntity> = {}): OrderDeadLetterEntity {
  return {
    id: 'row-1',
    eventId: 'evt-1',
    topic: 'orders.order-placed',
    payload: { eventId: 'evt-1', aggregateId: 'order-1', version: 1 },
    error: 'broker down',
    retryCount: 0,
    createdAt: NOW,
    status: DeadLetterStatus.PENDING_RETRY,
    nextRetryAt: NOW,
    lastAttemptAt: null,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function inboundRow(
  overrides: Partial<ConsumedMessageDeadLetterEntity> = {},
): ConsumedMessageDeadLetterEntity {
  return {
    id: 'in-1',
    topic: 'payments.payment-processed',
    partition: 0,
    offset: '41',
    messageKey: null,
    rawValue: '{"eventId":"evt-9"}',
    eventId: 'evt-9',
    orderId: 'order-9',
    failureType: ConsumedMessageFailureType.RETRIES_EXHAUSTED,
    error: 'order not found',
    attempts: 5,
    retryCount: 0,
    createdAt: NOW,
    status: DeadLetterStatus.PENDING_RETRY,
    nextRetryAt: NOW,
    lastAttemptAt: null,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

/** Lets pending promise callbacks run without advancing fake time. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** A promise the test resolves by hand, to hold an attempt open. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('DeadLetterRetryWorker', () => {
  let outbound: FakeStore<OrderDeadLetterEntity>;
  let inbound: FakeStore<ConsumedMessageDeadLetterEntity>;
  let republish: jest.Mock;
  let paymentProcess: jest.Mock;
  let projectionProcess: jest.Mock;
  let worker: DeadLetterRetryWorker;

  function build(settings: Partial<DeadLetterConfig> = {}): DeadLetterRetryWorker {
    const config = {
      getOrThrow: () => ({ ...SETTINGS, ...settings }),
    } as unknown as ConfigService;
    return new DeadLetterRetryWorker(
      config,
      outbound as unknown as OrderDeadLetterRepository,
      inbound as unknown as ConsumedMessageDeadLetterRepository,
      { republish } as unknown as OrderEventsProducer,
      {
        topics: ['payments.payment-processed', 'payments.payment-failed'],
        process: paymentProcess,
      } as unknown as PaymentEventsConsumer,
      {
        topics: ['orders.order-placed', 'orders.order-confirmed', 'orders.order-cancelled'],
        process: projectionProcess,
      } as unknown as OrderProjectionConsumer,
      () => NOW,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    outbound = new FakeStore();
    inbound = new FakeStore();
    republish = jest.fn().mockResolvedValue(undefined);
    paymentProcess = jest.fn().mockResolvedValue(undefined);
    projectionProcess = jest.fn().mockResolvedValue(undefined);
    worker = build();
  });

  afterEach(async () => {
    await worker.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('scheduling', () => {
    it('should return from bootstrap immediately and run no cycle before the interval', () => {
      worker.onApplicationBootstrap();
      jest.advanceTimersByTime(999);

      expect(outbound.processNextDue).not.toHaveBeenCalled();
    });

    it('should drain at most batchSize rows per cycle after one interval', async () => {
      outbound.queue.push(...[1, 2, 3, 4, 5].map((n) => outboundRow({ id: `row-${n}` })));
      worker.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(outbound.processNextDue).toHaveBeenCalledTimes(3);
      expect(outbound.queue).toHaveLength(2);
    });

    it('should end a cycle early when nothing more is due', async () => {
      outbound.queue.push(outboundRow());
      worker.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(outbound.processNextDue).toHaveBeenCalledTimes(2);
    });

    it('should never overlap a slow cycle and schedule the next one only after it ends', async () => {
      const slow = gate();
      republish.mockImplementationOnce(() => slow.promise);
      outbound.queue.push(outboundRow());
      worker.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(outbound.processNextDue).toHaveBeenCalledTimes(1);

      slow.release();
      await flush();
      expect(outbound.processNextDue).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(999);
      expect(outbound.processNextDue).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(outbound.processNextDue).toHaveBeenCalledTimes(3);
    });

    it('should log a database failure and keep scheduling', async () => {
      outbound.processNextDue.mockRejectedValueOnce(new Error('connection lost'));
      worker.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(2_000);

      expect(outbound.processNextDue).toHaveBeenCalledTimes(2);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('connection lost'),
      );
    });

    it('should never run when disabled', async () => {
      worker = build({ enabled: false });
      worker.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(10_000);

      expect(outbound.processNextDue).not.toHaveBeenCalled();
    });

    it('should wait for the in-flight attempt on shutdown and start nothing afterwards', async () => {
      const slow = gate();
      republish.mockImplementationOnce(() => slow.promise);
      outbound.queue.push(outboundRow({ id: 'a' }), outboundRow({ id: 'b' }));
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(1_000);

      let stopped = false;
      const stopping = worker.onModuleDestroy().then(() => {
        stopped = true;
      });
      await flush();
      expect(stopped).toBe(false);

      slow.release();
      await stopping;
      await jest.advanceTimersByTimeAsync(10_000);

      expect(outbound.processNextDue).toHaveBeenCalledTimes(1);
      expect(outbound.updates).toHaveLength(1);
    });
  });

  describe('outbound rows', () => {
    async function runOne(row: OrderDeadLetterEntity): Promise<RetryUpdate> {
      outbound.queue.push(row);
      await worker.runCycle();
      return outbound.updates[0];
    }

    it('should republish the stored payload to the stored topic and resolve the row', async () => {
      const row = outboundRow();

      const update = await runOne(row);

      expect(republish).toHaveBeenCalledWith('orders.order-placed', row.payload);
      expect(update).toMatchObject({
        status: DeadLetterStatus.RESOLVED,
        retryCount: 1,
        resolvedAt: NOW,
        lastError: null,
      });
    });

    it('should reschedule the row and warn when the publish fails', async () => {
      republish.mockRejectedValue(new Error('broker down'));

      const update = await runOne(outboundRow());

      expect(update).toMatchObject({
        status: DeadLetterStatus.PENDING_RETRY,
        retryCount: 1,
        nextRetryAt: new Date(NOW.getTime() + 5_000),
        lastError: 'broker down',
      });
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('row-1'));
    });

    it.each([
      ['a topic this service does not produce', { topic: 'payments.payment-processed' }],
      ['a payload without a string eventId', { payload: { aggregateId: 'order-1' } }],
      ['a payload without a string aggregateId', { payload: { eventId: 'evt-1', aggregateId: 7 } }],
    ])('should exhaust %s without publishing', async (_label, overrides) => {
      const update = await runOne(outboundRow(overrides));

      expect(republish).not.toHaveBeenCalled();
      expect(update.status).toBe(DeadLetterStatus.EXHAUSTED);
    });
  });

  describe('inbound rows', () => {
    async function runOne(row: ConsumedMessageDeadLetterEntity): Promise<RetryUpdate> {
      inbound.queue.push(row);
      await worker.runCycle();
      return inbound.updates[0];
    }

    it('should re-handle a payments.* row through the payment consumer and resolve it', async () => {
      const update = await runOne(inboundRow());

      expect(paymentProcess).toHaveBeenCalledWith(
        'payments.payment-processed',
        Buffer.from('{"eventId":"evt-9"}', 'utf8'),
      );
      expect(projectionProcess).not.toHaveBeenCalled();
      expect(update).toMatchObject({ status: DeadLetterStatus.RESOLVED, retryCount: 1 });
    });

    it('should re-handle an orders.* row through the projection consumer', async () => {
      await runOne(inboundRow({ topic: 'orders.order-confirmed' }));

      expect(projectionProcess).toHaveBeenCalledWith(
        'orders.order-confirmed',
        Buffer.from('{"eventId":"evt-9"}', 'utf8'),
      );
      expect(paymentProcess).not.toHaveBeenCalled();
    });

    it('should exhaust a row whose message turns out to be malformed', async () => {
      paymentProcess.mockRejectedValue(new MalformedMessageError('missing orderId'));

      const update = await runOne(inboundRow());

      expect(update).toMatchObject({
        status: DeadLetterStatus.EXHAUSTED,
        lastError: 'missing orderId',
      });
    });

    it('should reschedule a row whose handling fails for another reason', async () => {
      paymentProcess.mockRejectedValue(new Error('order not found'));

      const update = await runOne(inboundRow());

      expect(update).toMatchObject({
        status: DeadLetterStatus.PENDING_RETRY,
        nextRetryAt: new Date(NOW.getTime() + 5_000),
        lastError: 'order not found',
      });
    });

    it.each([
      ['an unknown topic', { topic: 'inventory.stock-reserved' }],
      ['a null raw value (tombstone)', { rawValue: null }],
    ])('should exhaust %s without handling it', async (_label, overrides) => {
      const update = await runOne(inboundRow(overrides));

      expect(paymentProcess).not.toHaveBeenCalled();
      expect(projectionProcess).not.toHaveBeenCalled();
      expect(update.status).toBe(DeadLetterStatus.EXHAUSTED);
    });

    it('should drain inbound rows too, up to batchSize per store', async () => {
      outbound.queue.push(outboundRow({ id: 'o-1' }));
      inbound.queue.push(...[1, 2, 3, 4].map((n) => inboundRow({ id: `in-${n}` })));

      await worker.runCycle();

      expect(outbound.updates).toHaveLength(1);
      expect(inbound.updates).toHaveLength(3);
      expect(inbound.queue).toHaveLength(1);
    });
  });
});
