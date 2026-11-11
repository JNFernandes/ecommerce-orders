import { TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { OrderViewRepository } from '../../src/read-model/order-view.repository';
import { buildReadModelTestingModule, mongoUri } from './support/read-model-testing';
import { OrderView } from '../../src/read-model/order-view';
import { OrderViewStatus } from '../../src/read-model/order-view-status.enum';
import { OrderViewConcurrencyError, ReadModelUnavailableError } from '../../src/read-model/errors';

jest.setTimeout(180_000);

const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function view(orderId: string, overrides: Partial<OrderView> = {}): OrderView {
  return {
    orderId,
    customerId: CUSTOMER_ID,
    status: OrderViewStatus.PENDING,
    items: [{ productId: 'p-1', quantity: 2, unitPrice: 9.99, subtotal: 19.98 }],
    totalAmount: 19.98,
    placedAt: new Date('2026-11-11T10:00:00.000Z'),
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: new Date('2026-11-11T10:00:00.000Z'),
    appliedEventIds: ['10000000-0000-4000-8000-000000000001'],
    statusEventId: null,
    ...overrides,
  };
}

describe('OrderViewRepository (integration, MongoDB)', () => {
  let container: StartedMongoDBContainer;
  let moduleRef: TestingModule;
  let repository: OrderViewRepository;
  let connection: Connection;
  let counter = 0;

  function nextOrderId(): string {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    moduleRef = await buildReadModelTestingModule(mongoUri(container.getConnectionString()));
    repository = moduleRef.get(OrderViewRepository);
    connection = moduleRef.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await moduleRef.close();
    await container.stop();
  });

  it('should insert a view and read it back with every field, at revision 1', async () => {
    const orderId = nextOrderId();
    const original = view(orderId);

    await repository.insert(original);
    const stored = await repository.findById(orderId);

    expect(stored).toEqual({ view: original, revision: 1 });
  });

  it('should round-trip nulls and Dates for a view created by a terminal event', async () => {
    const orderId = nextOrderId();
    const terminal = view(orderId, {
      status: OrderViewStatus.CANCELLED,
      items: null,
      totalAmount: null,
      placedAt: null,
      cancelledAt: new Date('2026-11-11T10:00:05.000Z'),
      cancellationReason: '',
      statusEventId: '30000000-0000-4000-8000-000000000003',
    });

    await repository.insert(terminal);

    expect((await repository.findById(orderId))?.view).toEqual(terminal);
  });

  it('should store a clean document: _id is the order id, no __v, no Mongoose timestamps, no item _id', async () => {
    const orderId = nextOrderId();
    await repository.insert(view(orderId));

    const raw = await connection.collection('order_views').findOne({ _id: orderId as never });

    expect(raw).not.toBeNull();
    expect(Object.keys(raw ?? {}).sort()).toEqual(
      [
        '_id',
        'appliedEventIds',
        'cancellationReason',
        'cancelledAt',
        'confirmedAt',
        'customerId',
        'items',
        'orderId',
        'placedAt',
        'revision',
        'status',
        'statusEventId',
        'totalAmount',
        'updatedAt',
      ].sort(),
    );
    expect(raw?._id).toBe(orderId);
    expect(Object.keys((raw?.items as object[])[0]).sort()).toEqual(
      ['productId', 'quantity', 'subtotal', 'unitPrice'].sort(),
    );
  });

  it('should throw OrderViewConcurrencyError when inserting an id that already exists', async () => {
    const orderId = nextOrderId();
    await repository.insert(view(orderId));

    await expect(repository.insert(view(orderId))).rejects.toThrow(OrderViewConcurrencyError);
  });

  it('should replace at the expected revision and bump it', async () => {
    const orderId = nextOrderId();
    await repository.insert(view(orderId));
    const confirmed = view(orderId, {
      status: OrderViewStatus.CONFIRMED,
      confirmedAt: new Date('2026-11-11T10:00:01.000Z'),
      updatedAt: new Date('2026-11-11T10:00:01.000Z'),
      appliedEventIds: [
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
      ],
      statusEventId: '20000000-0000-4000-8000-000000000002',
    });

    await repository.replace(confirmed, 1);

    expect(await repository.findById(orderId)).toEqual({ view: confirmed, revision: 2 });
  });

  it('should throw OrderViewConcurrencyError when replacing at a stale revision', async () => {
    const orderId = nextOrderId();
    await repository.insert(view(orderId));
    await repository.replace(view(orderId, { totalAmount: 1 }), 1);

    await expect(repository.replace(view(orderId, { totalAmount: 2 }), 1)).rejects.toThrow(
      OrderViewConcurrencyError,
    );
    expect((await repository.findById(orderId))?.view.totalAmount).toBe(1);
  });

  it('should return null for an unknown order id', async () => {
    expect(await repository.findById(nextOrderId())).toBeNull();
  });
});

describe('OrderViewRepository (integration, MongoDB unavailable)', () => {
  it('should report ReadModelUnavailableError when MongoDB goes away after connecting', async () => {
    const container = await new MongoDBContainer('mongo:7').start();
    const moduleRef = await buildReadModelTestingModule(mongoUri(container.getConnectionString()));
    const repository = moduleRef.get(OrderViewRepository);
    await repository.insert(view('00000000-0000-4000-8000-0000000000aa'));

    await container.stop();

    await expect(repository.findById('00000000-0000-4000-8000-0000000000aa')).rejects.toThrow(
      ReadModelUnavailableError,
    );
    await expect(repository.insert(view('00000000-0000-4000-8000-0000000000bb'))).rejects.toThrow(
      ReadModelUnavailableError,
    );
    await moduleRef.close().catch(() => undefined);
  });

  it('should report ReadModelUnavailableError when the initial connection never succeeded', async () => {
    const moduleRef = await buildReadModelTestingModule('mongodb://localhost:27997/unreachable', {
      lazy: true,
    });
    const repository = moduleRef.get(OrderViewRepository);
    const orderId = '00000000-0000-4000-8000-0000000000cc';

    await expect(repository.findById(orderId)).rejects.toThrow(ReadModelUnavailableError);
    await expect(repository.insert(view(orderId))).rejects.toThrow(ReadModelUnavailableError);
    await expect(repository.replace(view(orderId), 1)).rejects.toThrow(ReadModelUnavailableError);
    await moduleRef.close().catch(() => undefined);
  });
});
