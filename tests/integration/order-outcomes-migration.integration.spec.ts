import { randomUUID } from 'crypto';
import { DataSource, MigrationInterface } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CreatePlaceOrderSchema20260707120000 } from '../../src/infra/database/migrations/20260707120000-CreatePlaceOrderSchema';
import { AddPaymentOutcomeConsumerSchema20261111120000 } from '../../src/infra/database/migrations/20261111120000-AddPaymentOutcomeConsumerSchema';
import { AddDeadLetterRetryBookkeeping20261112120000 } from '../../src/infra/database/migrations/20261112120000-AddDeadLetterRetryBookkeeping';
import { AddOrderOutcomes20261114120000 } from '../../src/infra/database/migrations/20261114120000-AddOrderOutcomes';

jest.setTimeout(180_000);

type MigrationClass = new () => MigrationInterface;

const BEFORE_US09: MigrationClass[] = [
  CreatePlaceOrderSchema20260707120000,
  AddPaymentOutcomeConsumerSchema20261111120000,
  AddDeadLetterRetryBookkeeping20261112120000,
];
const WITH_US09: MigrationClass[] = [...BEFORE_US09, AddOrderOutcomes20261114120000];

interface OutcomeRow {
  id: string;
  status: string;
  paymentOutcome: string;
  stockOutcome: string;
}

describe('AddOrderOutcomes migration (integration, real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  });

  afterAll(async () => {
    await container.stop();
  });

  /** A data source on a fresh database inside the shared container. */
  async function dataSourceFor(
    database: string,
    migrations: MigrationClass[],
  ): Promise<DataSource> {
    const dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database,
      migrations,
    });
    await dataSource.initialize();
    return dataSource;
  }

  /** Creates an empty database and migrates it up to just before US-09. */
  async function databaseBeforeUs09(): Promise<string> {
    const name = `m_${randomUUID().replace(/-/g, '')}`;
    const admin = await dataSourceFor(container.getDatabase(), []);
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.destroy();

    const before = await dataSourceFor(name, BEFORE_US09);
    await before.runMigrations();
    await before.destroy();
    return name;
  }

  async function insertOrder(dataSource: DataSource, status: string): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO "orders" ("id", "customerId", "status", "totalAmount") VALUES ($1, $2, $3, 10)`,
      [id, randomUUID(), status],
    );
    return id;
  }

  async function outcomes(dataSource: DataSource): Promise<Map<string, OutcomeRow>> {
    const rows = (await dataSource.query(
      `SELECT "id", "status", "paymentOutcome", "stockOutcome" FROM "orders"`,
    )) as OutcomeRow[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  it('should backfill CONFIRMED orders as PROCESSED/RESERVED and leave the others PENDING/PENDING', async () => {
    const name = await databaseBeforeUs09();
    const seed = await dataSourceFor(name, BEFORE_US09);
    const pendingId = await insertOrder(seed, 'PENDING');
    const confirmedId = await insertOrder(seed, 'CONFIRMED');
    const cancelledId = await insertOrder(seed, 'CANCELLED');
    await seed.destroy();

    const dataSource = await dataSourceFor(name, WITH_US09);
    const applied = await dataSource.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual(['AddOrderOutcomes20261114120000']);

    const rows = await outcomes(dataSource);
    expect(rows.get(confirmedId)).toMatchObject({
      paymentOutcome: 'PROCESSED',
      stockOutcome: 'RESERVED',
    });
    expect(rows.get(pendingId)).toMatchObject({
      paymentOutcome: 'PENDING',
      stockOutcome: 'PENDING',
    });
    expect(rows.get(cancelledId)).toMatchObject({
      paymentOutcome: 'PENDING',
      stockOutcome: 'PENDING',
    });

    const newId = await insertOrder(dataSource, 'PENDING');
    expect((await outcomes(dataSource)).get(newId)).toMatchObject({
      paymentOutcome: 'PENDING',
      stockOutcome: 'PENDING',
    });
    await dataSource.destroy();
  });

  it('should require exactly one of paymentId and reservationId on processed events', async () => {
    const name = await databaseBeforeUs09();
    const dataSource = await dataSourceFor(name, WITH_US09);
    await dataSource.runMigrations();

    const insert = (paymentId: string | null, reservationId: string | null): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "processed_events" ("eventId", "topic", "orderId", "paymentId", "reservationId", "outcome") ` +
          `VALUES ($1, 'inventory.stock-reserved', $2, $3, $4, 'RECORDED')`,
        [randomUUID(), randomUUID(), paymentId, reservationId],
      );

    await expect(insert(null, randomUUID())).resolves.toBeDefined();
    await expect(insert(randomUUID(), null)).resolves.toBeDefined();
    await expect(insert(null, null)).rejects.toThrow(/CHK_processed_events_one_source_id/);
    await expect(insert(randomUUID(), randomUUID())).rejects.toThrow(
      /CHK_processed_events_one_source_id/,
    );
    await dataSource.destroy();
  });

  it('should restore the previous schema on down()', async () => {
    const name = await databaseBeforeUs09();
    const dataSource = await dataSourceFor(name, WITH_US09);
    await dataSource.runMigrations();
    await dataSource.query(
      `INSERT INTO "processed_events" ("eventId", "topic", "orderId", "paymentId", "outcome") ` +
        `VALUES ($1, 'payments.payment-processed', $2, $3, 'CONFIRMED')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    await dataSource.query(
      `INSERT INTO "processed_events" ("eventId", "topic", "orderId", "reservationId", "outcome") ` +
        `VALUES ($1, 'inventory.stock-reserved', $2, $3, 'RECORDED')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );

    await dataSource.undoLastMigration();

    const columns = (await dataSource.query(
      `SELECT "table_name", "column_name", "is_nullable" FROM information_schema.columns ` +
        `WHERE "table_name" IN ('orders', 'processed_events')`,
    )) as Array<{ table_name: string; column_name: string; is_nullable: string }>;
    const names = columns.map((column) => `${column.table_name}.${column.column_name}`);
    expect(names).not.toContain('orders.paymentOutcome');
    expect(names).not.toContain('orders.stockOutcome');
    expect(names).not.toContain('processed_events.reservationId');
    expect(columns.find((column) => column.column_name === 'paymentId')?.is_nullable).toBe('NO');

    const types = (await dataSource.query(
      `SELECT "typname" FROM pg_type WHERE "typname" LIKE 'order_%_outcome_enum'`,
    )) as Array<{ typname: string }>;
    expect(types).toEqual([]);

    const values = (await dataSource.query(
      `SELECT unnest(enum_range(NULL::"processed_event_outcome_enum"))::text AS "value"`,
    )) as Array<{ value: string }>;
    expect(values.map((row) => row.value)).toEqual([
      'CONFIRMED',
      'CANCELLED',
      'IGNORED_ALREADY_CONFIRMED',
      'IGNORED_ALREADY_CANCELLED',
      'IGNORED_CONFLICT',
    ]);

    const remaining = (await dataSource.query(`SELECT "topic" FROM "processed_events"`)) as Array<{
      topic: string;
    }>;
    expect(remaining).toEqual([{ topic: 'payments.payment-processed' }]);
    await dataSource.destroy();
  });
});
