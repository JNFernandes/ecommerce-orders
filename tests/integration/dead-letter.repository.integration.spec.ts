import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CreatePlaceOrderSchema20260707120000 } from '../../src/infra/database/migrations/20260707120000-CreatePlaceOrderSchema';
import { AddPaymentOutcomeConsumerSchema20261111120000 } from '../../src/infra/database/migrations/20261111120000-AddPaymentOutcomeConsumerSchema';
import { AddDeadLetterRetryBookkeeping20261112120000 } from '../../src/infra/database/migrations/20261112120000-AddDeadLetterRetryBookkeeping';
import { OrderDeadLetterEntity } from '../../src/infra/database/entities/order-dead-letter.entity';
import { ConsumedMessageDeadLetterEntity } from '../../src/infra/database/entities/consumed-message-dead-letter.entity';
import { DeadLetterStatus } from '../../src/infra/database/entities/dead-letter-status.enum';
import { OrderDeadLetterRepository } from '../../src/repositories/order-dead-letter.repository';
import { ConsumedMessageDeadLetterRepository } from '../../src/repositories/consumed-message-dead-letter.repository';
import { RetryUpdate } from '../../src/infra/dead-letter/retry-policy';

jest.setTimeout(180_000);

const PRE_US08_MIGRATIONS = [
  CreatePlaceOrderSchema20260707120000,
  AddPaymentOutcomeConsumerSchema20261111120000,
];

function dataSourceFor(
  container: StartedPostgreSqlContainer,
  migrations: Array<new () => unknown>,
): DataSource {
  return new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: [OrderDeadLetterEntity, ConsumedMessageDeadLetterEntity],
    migrations,
    synchronize: false,
  });
}

/** An update that marks a row resolved (what the handler would return on success). */
function resolved(retryCount: number): RetryUpdate {
  const now = new Date();
  return {
    status: DeadLetterStatus.RESOLVED,
    retryCount: retryCount + 1,
    nextRetryAt: now,
    lastAttemptAt: now,
    lastError: null,
    resolvedAt: now,
  };
}

describe('Dead-letter retry bookkeeping (integration, PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let outbound: OrderDeadLetterRepository;
  let inbound: ConsumedMessageDeadLetterRepository;
  const legacy = { outbound: randomUUID(), malformed: randomUUID(), exhausted: randomUUID() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // 1. Schema as it was before US-08, with rows written by the old code.
    const before = dataSourceFor(container, PRE_US08_MIGRATIONS);
    await before.initialize();
    await before.runMigrations();
    await before.query(
      `INSERT INTO order_dead_letters (id, "eventId", topic, payload, error)
       VALUES ($1, $2, 'orders.order-placed', '{"eventId":"e"}', 'broker down')`,
      [legacy.outbound, randomUUID()],
    );
    for (const [id, failureType] of [
      [legacy.malformed, 'MALFORMED'],
      [legacy.exhausted, 'RETRIES_EXHAUSTED'],
    ]) {
      await before.query(
        `INSERT INTO consumed_message_dead_letters
           (id, topic, partition, "offset", "rawValue", "failureType", error, attempts)
         VALUES ($1, 'payments.payment-processed', 0, '1', 'x', $2, 'e', 1)`,
        [id, failureType],
      );
    }
    await before.destroy();

    // 2. Apply the US-08 migration on top.
    dataSource = dataSourceFor(container, [
      ...PRE_US08_MIGRATIONS,
      AddDeadLetterRetryBookkeeping20261112120000,
    ]);
    await dataSource.initialize();
    await dataSource.runMigrations();

    outbound = new OrderDeadLetterRepository(
      dataSource.getRepository(OrderDeadLetterEntity),
      dataSource,
    );
    inbound = new ConsumedMessageDeadLetterRepository(
      dataSource.getRepository(ConsumedMessageDeadLetterEntity),
      dataSource,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  describe('migration backfill', () => {
    it('should make existing outbound rows pending and due now', async () => {
      const [row] = await dataSource.query(
        `SELECT status, "retryCount", "nextRetryAt" <= now() AS due FROM order_dead_letters WHERE id = $1`,
        [legacy.outbound],
      );
      expect(row).toEqual({ status: 'PENDING_RETRY', retryCount: 0, due: true });
    });

    it('should exhaust existing malformed inbound rows and keep the others pending', async () => {
      const rows = await dataSource.query(
        `SELECT id, status, "retryCount" FROM consumed_message_dead_letters WHERE id = ANY($1)`,
        [[legacy.malformed, legacy.exhausted]],
      );
      const byId = Object.fromEntries(
        rows.map((r: { id: string; status: string }) => [r.id, r.status]),
      );
      expect(byId[legacy.malformed]).toBe('EXHAUSTED');
      expect(byId[legacy.exhausted]).toBe('PENDING_RETRY');
    });

    it('should create the partial indexes used to find due rows', async () => {
      const rows = await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('IDX_order_dead_letters_due', 'IDX_consumed_dead_letters_due') ORDER BY indexname`,
      );
      expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual([
        'IDX_consumed_dead_letters_due',
        'IDX_order_dead_letters_due',
      ]);
    });
  });

  describe('claiming with processNextDue', () => {
    beforeEach(async () => {
      await dataSource.query('DELETE FROM order_dead_letters');
      await dataSource.query('DELETE FROM consumed_message_dead_letters');
    });

    async function seedOutbound(
      id: string,
      overrides: { status?: string; nextRetryAtSql?: string } = {},
    ): Promise<void> {
      await dataSource.query(
        `INSERT INTO order_dead_letters (id, "eventId", topic, payload, error, status, "nextRetryAt")
         VALUES ($1, $2, 'orders.order-placed', '{"eventId":"e"}', 'e', $3, ${overrides.nextRetryAtSql ?? 'now()'})`,
        [id, randomUUID(), overrides.status ?? 'PENDING_RETRY'],
      );
    }

    it('should return false when nothing is due', async () => {
      await seedOutbound(randomUUID(), { nextRetryAtSql: "now() + interval '1 hour'" });
      await seedOutbound(randomUUID(), { status: 'RESOLVED' });
      await seedOutbound(randomUUID(), { status: 'EXHAUSTED' });

      const handler = jest.fn();
      expect(await outbound.processNextDue(handler)).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should pick the oldest due row first and apply the handler update in the same transaction', async () => {
      const older = randomUUID();
      const newer = randomUUID();
      await seedOutbound(newer, { nextRetryAtSql: "now() - interval '1 minute'" });
      await seedOutbound(older, { nextRetryAtSql: "now() - interval '1 hour'" });

      const seen: string[] = [];
      expect(
        await outbound.processNextDue(async (row) => {
          seen.push(row.id);
          return resolved(row.retryCount);
        }),
      ).toBe(true);

      expect(seen).toEqual([older]);
      const [row] = await dataSource.query(
        `SELECT status, "retryCount", "resolvedAt" IS NOT NULL AS has_resolved FROM order_dead_letters WHERE id = $1`,
        [older],
      );
      expect(row).toEqual({ status: 'RESOLVED', retryCount: 1, has_resolved: true });
    });

    it('should leave the row unchanged and still due when the handler throws (rollback)', async () => {
      const id = randomUUID();
      await seedOutbound(id);

      await expect(
        outbound.processNextDue(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const [row] = await dataSource.query(
        `SELECT status, "retryCount" FROM order_dead_letters WHERE id = $1`,
        [id],
      );
      expect(row).toEqual({ status: 'PENDING_RETRY', retryCount: 0 });
      const again = jest.fn().mockResolvedValue(resolved(0));
      expect(await outbound.processNextDue(again)).toBe(true);
      expect(again).toHaveBeenCalledTimes(1);
    });

    it('should claim inbound rows the same way', async () => {
      const id = randomUUID();
      await dataSource.query(
        `INSERT INTO consumed_message_dead_letters
           (id, topic, partition, "offset", "rawValue", "failureType", error, attempts)
         VALUES ($1, 'payments.payment-processed', 0, '7', 'raw', 'RETRIES_EXHAUSTED', 'e', 5)`,
        [id],
      );

      let claimed = '';
      expect(
        await inbound.processNextDue(async (row) => {
          claimed = `${row.id}|${row.rawValue}|${row.attempts}`;
          return resolved(row.retryCount);
        }),
      ).toBe(true);
      expect(claimed).toBe(`${id}|raw|5`);
      expect(await inbound.processNextDue(jest.fn())).toBe(false);
    });

    it('should insert malformed inbound records directly as EXHAUSTED', async () => {
      await inbound.recordMalformed(
        {
          topic: 'payments.payment-failed',
          partition: 0,
          offset: '3',
          messageKey: null,
          rawValue: 'nope',
        },
        new Error('not JSON'),
      );

      const [row] = await dataSource.query(
        `SELECT status FROM consumed_message_dead_letters WHERE "rawValue" = 'nope'`,
      );
      expect(row.status).toBe(DeadLetterStatus.EXHAUSTED);
    });
  });
});
