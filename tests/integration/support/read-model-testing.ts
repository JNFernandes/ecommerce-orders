import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from '../../../src/config/configuration';
import { configureApp } from '../../../src/app.setup';
import { buildGraphqlOptions } from '../../../src/graphql/graphql.config';
import { OrdersResolver } from '../../../src/controllers/orders.resolver';
import { ListOrdersService } from '../../../src/services/list-orders.service';
import { GetOrderService } from '../../../src/services/get-order.service';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderViewDocument, OrderViewSchema } from '../../../src/read-model/order-view.schema';
import { OrderProjectionService } from '../../../src/read-model/order-projection.service';
import { observeReadModelConnection } from '../../../src/read-model/read-model-connection';

/** Connection string for a started MongoDBContainer (single-node replica set). */
export function mongoUri(connectionString: string, database = 'orders_read_test'): string {
  return `${connectionString}/${database}?directConnection=true`;
}

/**
 * Builds a Nest testing module with a real Mongoose connection, the order_views model,
 * OrderViewRepository and OrderProjectionService — no Kafka, no PostgreSQL.
 *
 * `lazy: true` mirrors the production ReadModelModule (lazy connection, observed so a failed
 * initial connect does not crash the test process); use it to point at an unreachable server.
 */
export async function buildReadModelTestingModule(
  uri: string,
  options: { lazy?: boolean } = {},
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, {
        bufferCommands: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 2000,
        ...(options.lazy
          ? { lazyConnection: true, connectionFactory: observeReadModelConnection }
          : {}),
      }),
      MongooseModule.forFeature([{ name: OrderViewDocument.name, schema: OrderViewSchema }]),
    ],
    providers: [OrderViewRepository, OrderProjectionService],
  }).compile();
}

/**
 * Builds and initialises a Nest app serving the GraphQL read path against MongoDB at `uri`:
 * ConfigModule, CqrsModule, GraphQLModule (the app's own options factory), the read model,
 * OrdersResolver and ListOrdersService — no Kafka, no PostgreSQL. Uses `configureApp` so
 * validation behaves exactly as in production.
 */
export async function buildGraphqlTestingApp(uri: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
      CqrsModule.forRoot(),
      GraphQLModule.forRootAsync<ApolloDriverConfig>({
        driver: ApolloDriver,
        inject: [ConfigService],
        useFactory: buildGraphqlOptions,
      }),
      MongooseModule.forRoot(uri, {
        bufferCommands: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 2000,
      }),
      MongooseModule.forFeature([{ name: OrderViewDocument.name, schema: OrderViewSchema }]),
    ],
    providers: [OrderViewRepository, OrdersResolver, ListOrdersService, GetOrderService],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.get(OrderViewRepository).ensureIndexes();
  return app;
}
