import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { printOrdersSchema } from '../src/graphql/print-schema';

/**
 * Writes the GraphQL schema (SDL) to docs/schema.gql. Run after any change to resolvers, GraphQL
 * types or descriptions; tests/unit/graphql/schema.spec.ts fails while the file is out of date.
 */
async function main(): Promise<void> {
  const target = join(__dirname, '..', 'docs', 'schema.gql');
  writeFileSync(target, await printOrdersSchema(), 'utf8');
  process.stdout.write(`GraphQL schema written to ${target}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
