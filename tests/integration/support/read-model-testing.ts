import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderViewDocument, OrderViewSchema } from '../../../src/read-model/order-view.schema';
import { OrderProjectionService } from '../../../src/read-model/order-projection.service';

/** Connection string for a started MongoDBContainer (single-node replica set). */
export function mongoUri(connectionString: string, database = 'orders_read_test'): string {
  return `${connectionString}/${database}?directConnection=true`;
}

/**
 * Builds a Nest testing module with a real Mongoose connection, the order_views model,
 * OrderViewRepository and OrderProjectionService — no Kafka, no PostgreSQL.
 */
export async function buildReadModelTestingModule(uri: string): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, { bufferCommands: false, serverSelectionTimeoutMS: 2000 }),
      MongooseModule.forFeature([{ name: OrderViewDocument.name, schema: OrderViewSchema }]),
    ],
    providers: [OrderViewRepository, OrderProjectionService],
  }).compile();
}
