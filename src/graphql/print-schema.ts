import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { OrdersResolver } from '../controllers/orders.resolver';

/** Resolvers that make up the public GraphQL schema. */
const RESOLVERS = [OrdersResolver];

/**
 * Builds the code-first GraphQL schema from the resolver metadata alone (no database, no Kafka,
 * no HTTP server) — the same schema the app generates in memory at startup.
 */
export async function buildOrdersSchema(): Promise<GraphQLSchema> {
  const context = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  try {
    const factory = context.get(GraphQLSchemaFactory);
    return lexicographicSortSchema(await factory.create(RESOLVERS));
  } finally {
    await context.close();
  }
}

/** The schema as SDL — what `npm run schema:generate` writes to docs/schema.gql. */
export async function printOrdersSchema(): Promise<string> {
  return `${printSchema(await buildOrdersSchema())}\n`;
}
