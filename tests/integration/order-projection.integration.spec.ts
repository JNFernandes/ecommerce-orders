import { Logger } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { OrderProjectionService } from '../../src/read-model/order-projection.service';
import { OrderEvent } from '../../src/read-model/order-event';
import { buildReadModelTestingModule, mongoUri } from './support/read-model-testing';

jest.setTimeout(180_000);

const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const T0 = new Date('2026-11-11T10:00:00.000Z');
const T1 = new Date('2026-11-11T10:00:01.000Z');

type StoredDocument = Record<string, unknown> & { _id: string };

/** The three event kinds for one order, with ids derived from a seed so tests stay readable. */
function eventsFor(orderId: string, seed: number, outcome: 'confirm' | 'cancel'): OrderEvent[] {
  const id = (n: number): string =>
    `${String(seed).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const placed: OrderEvent = {
    type: 'OrderPlaced',
    eventId: id(1),
    orderId,
    occurredAt: T0,
    customerId: CUSTOMER_ID,
    items: [
      { productId: 'p-1', quantity: 2, unitPrice: 9.99 },
      { productId: 'p-2', quantity: 1, unitPrice: 5 },
    ],
    totalAmount: 24.98,
  };
  const terminal: OrderEvent =
    outcome === 'confirm'
      ? { type: 'OrderConfirmed', eventId: id(2), orderId, occurredAt: T1, customerId: CUSTOMER_ID }
      : {
          type: 'OrderCancelled',
          eventId: id(2),
          orderId,
          occurredAt: T1,
          customerId: CUSTOMER_ID,
          reason: 'Amount exceeds threshold',
        };
  return [placed, terminal];
}

/** Strips the order identity so two documents for different orders can be compared. */
function withoutIdentity(document: StoredDocument | null): Record<string, unknown> {
  expect(document).not.toBeNull();
  const { _id, orderId, appliedEventIds, statusEventId, ...rest } = document as StoredDocument;
  void _id;
  void orderId;
  return {
    ...rest,
    appliedEventIdCount: (appliedEventIds as string[]).length,
    hasStatusEvent: statusEventId !== null,
  };
}

describe('OrderProjectionService (integration, MongoDB)', () => {
  let container: StartedMongoDBContainer;
  let moduleRef: TestingModule;
  let service: OrderProjectionService;
  let connection: Connection;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    container = await new MongoDBContainer('mongo:7').start();
    moduleRef = await buildReadModelTestingModule(mongoUri(container.getConnectionString()));
    service = moduleRef.get(OrderProjectionService);
    connection = moduleRef.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await moduleRef.close();
    await container.stop();
    jest.restoreAllMocks();
  });

  async function stored(orderId: string): Promise<StoredDocument | null> {
    return connection.collection<StoredDocument>('order_views').findOne({ _id: orderId });
  }

  async function projectAll(events: OrderEvent[]): Promise<void> {
    for (const event of events) {
      await service.project(event);
    }
  }

  it.each(['confirm', 'cancel'] as const)(
    'should store the same document whichever arrives first, placed or the terminal event (%s)',
    async (outcome) => {
      const inOrderId = `a${outcome === 'confirm' ? 1 : 2}000000-0000-4000-8000-000000000000`;
      const reversedId = `b${outcome === 'confirm' ? 1 : 2}000000-0000-4000-8000-000000000000`;
      const inOrder = eventsFor(inOrderId, 1, outcome);
      const reversed = eventsFor(reversedId, 2, outcome).reverse();

      await projectAll(inOrder);
      await projectAll(reversed);

      const a = await stored(inOrderId);
      const b = await stored(reversedId);
      expect(withoutIdentity(b)).toEqual(withoutIdentity(a));
      expect(a).toMatchObject({
        status: outcome === 'confirm' ? 'CONFIRMED' : 'CANCELLED',
        totalAmount: 24.98,
        placedAt: T0,
        updatedAt: T1,
        revision: 2,
      });
    },
  );
});
