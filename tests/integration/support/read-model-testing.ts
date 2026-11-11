import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
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
