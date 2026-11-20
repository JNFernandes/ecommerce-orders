import { randomUUID } from 'crypto';
import { DataSource, MigrationInterface } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CreatePlaceOrderSchema20260707120000 } from '../../src/infra/database/migrations/20260707120000-CreatePlaceOrderSchema';
import { AddPaymentOutcomeConsumerSchema20261111120000 } from '../../src/infra/database/migrations/20261111120000-AddPaymentOutcomeConsumerSchema';
import { AddDeadLetterRetryBookkeeping20261112120000 } from '../../src/infra/database/migrations/20261112120000-AddDeadLetterRetryBookkeeping';
import { AddOrderOutcomes20261114120000 } from '../../src/infra/database/migrations/20261114120000-AddOrderOutcomes';
import { AddCustomerRegistration20261119120000 } from '../../src/infra/database/migrations/20261119120000-AddCustomerRegistration';

jest.setTimeout(180_000);

type MigrationClass = new () => MigrationInterface;

const ALL: MigrationClass[] = [
  CreatePlaceOrderSchema20260707120000,
  AddPaymentOutcomeConsumerSchema20261111120000,
  AddDeadLetterRetryBookkeeping20261112120000,
  AddOrderOutcomes20261114120000,
  AddCustomerRegistration20261119120000,
];

describe('AddCustomerRegistration migration (integration, real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      migrations: ALL,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  it('should keep existing customers and payment/stock processed events across down then up', async () => {
    const seededCustomer = randomUUID();
    const registeredCustomer = randomUUID();
    await dataSource.query(`INSERT INTO "customers" ("id") VALUES ($1)`, [seededCustomer]);
    await dataSource.query(
      `INSERT INTO "customers" ("id", "name", "email") VALUES ($1, 'Ada', 'ada@example.com')`,
      [registeredCustomer],
    );
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
    await dataSource.query(
      `INSERT INTO "processed_events" ("eventId", "topic", "customerId", "outcome") ` +
        `VALUES ($1, 'identity.user-registered', $2, 'CUSTOMER_CREATED')`,
      [randomUUID(), registeredCustomer],
    );

    await dataSource.undoLastMigration();
    await dataSource.runMigrations();

    const customers = (await dataSource.query(`SELECT "id" FROM "customers"`)) as Array<{
      id: string;
    }>;
    expect(customers.map((row) => row.id).sort()).toEqual(
      [seededCustomer, registeredCustomer].sort(),
    );
    const topics = (await dataSource.query(
      `SELECT "topic" FROM "processed_events" ORDER BY "topic"`,
    )) as Array<{ topic: string }>;
    expect(topics.map((row) => row.topic)).toEqual([
      'inventory.stock-reserved',
      'payments.payment-processed',
    ]);
  });
});
