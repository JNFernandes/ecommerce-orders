import { readdirSync } from 'fs';
import { dirname } from 'path';
import configuration, { DatabaseConfig } from '../../../src/config/configuration';
import { buildTypeOrmOptions, MIGRATIONS_GLOB } from '../../../src/infra/database/typeorm-options';

const dbConfig: DatabaseConfig = {
  host: 'db',
  port: 5432,
  username: 'user',
  password: 'pass',
  database: 'orders',
  migrationsRun: true,
};

describe('buildTypeOrmOptions', () => {
  it('runs the migrations at startup and never synchronizes the schema', () => {
    const options = buildTypeOrmOptions(dbConfig);

    expect(options).toMatchObject({
      type: 'postgres',
      host: 'db',
      port: 5432,
      username: 'user',
      password: 'pass',
      database: 'orders',
      synchronize: false,
      migrationsRun: true,
      migrations: [MIGRATIONS_GLOB],
    });
  });

  it('skips the migrations when migrationsRun is false', () => {
    expect(buildTypeOrmOptions({ ...dbConfig, migrationsRun: false }).migrationsRun).toBe(false);
  });

  it('points the migrations glob at the directory that holds the migrations', () => {
    const migrationsDir = dirname(MIGRATIONS_GLOB);

    expect(readdirSync(migrationsDir).some((file) => file.endsWith('.ts'))).toBe(true);
  });
});

describe('DB_MIGRATIONS_RUN', () => {
  const original = process.env.DB_MIGRATIONS_RUN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DB_MIGRATIONS_RUN;
    } else {
      process.env.DB_MIGRATIONS_RUN = original;
    }
  });

  it('defaults to running the migrations', () => {
    delete process.env.DB_MIGRATIONS_RUN;

    expect(configuration().database.migrationsRun).toBe(true);
  });

  it('disables them only when set to "false"', () => {
    process.env.DB_MIGRATIONS_RUN = 'false';

    expect(configuration().database.migrationsRun).toBe(false);
  });
});
