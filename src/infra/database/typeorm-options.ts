import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DatabaseConfig } from '../../config/configuration';

/**
 * Glob of the TypeORM migrations, next to this file. It resolves to the `.ts` sources under
 * ts-node and to the compiled `.js` files in `dist` (TypeORM skips `.d.ts` files).
 */
export const MIGRATIONS_GLOB = `${__dirname}/migrations/*{.ts,.js}`;

/**
 * Builds the application's TypeORM options. The schema is owned by the migrations: `synchronize`
 * is always off, and pending migrations are applied at startup unless `migrationsRun` is false.
 */
export function buildTypeOrmOptions(dbConfig: DatabaseConfig | undefined): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig?.host,
    port: dbConfig?.port,
    username: dbConfig?.username,
    password: dbConfig?.password,
    database: dbConfig?.database,
    autoLoadEntities: true,
    synchronize: false,
    migrations: [MIGRATIONS_GLOB],
    migrationsRun: dbConfig?.migrationsRun ?? true,
  };
}
