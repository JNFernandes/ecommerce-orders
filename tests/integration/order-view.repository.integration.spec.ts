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

  it('should create the list indexes, and be idempotent', async () => {
    await repository.ensureIndexes();
    await repository.ensureIndexes();

    const indexes = await connection.collection('order_views').listIndexes().toArray();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index.key]));
    expect(byName.customerId_placedAt).toEqual({ customerId: 1, placedAt: -1, _id: -1 });
    expect(byName.customerId_status_placedAt).toEqual({
      customerId: 1,
      status: 1,
      placedAt: -1,
      _id: -1,
    });
    expect(byName.status_placedAt).toEqual({ status: 1, placedAt: -1, _id: -1 });
    expect(byName.placedAt).toEqual({ placedAt: -1, _id: -1 });
  });

  it('should list newest first with ties by id, nulls last, paged, with the total count', async () => {
    const customerId = '11111111-0000-4000-8000-000000000000';
    const at = (minute: number | null): Date | null =>
      minute === null ? null : new Date(Date.UTC(2026, 10, 12, 9, minute));
    const ids = ['l1', 'l2', 'l3', 'l4'].map(
      (_suffix, i) => `22222222-0000-4000-8000-00000000000${i + 1}`,
    );
    const minutes = [1, 3, 3, null];
    for (let i = 0; i < ids.length; i++) {
      await repository.insert(
        view(ids[i], { customerId, placedAt: at(minutes[i]), updatedAt: new Date() }),
      );
    }

    const first = await repository.list({ customerId }, { limit: 2, offset: 0 });
    const second = await repository.list({ customerId }, { limit: 2, offset: 2 });

    expect(first.totalCount).toBe(4);
    expect(first.views.map((v) => v.orderId)).toEqual([ids[2], ids[1]]);
    expect(second.views.map((v) => v.orderId)).toEqual([ids[0], ids[3]]);
  });

  it('should return null for an unknown order id', async () => {
    expect(await repository.findById(nextOrderId())).toBeNull();
  });

  describe('owner scoping (US-12)', () => {
    const OWNER_A = '33333333-0000-4000-8000-00000000000a';
    const OWNER_B = '33333333-0000-4000-8000-00000000000b';
    const idsA: string[] = [];
    let orderOfB = '';

    beforeAll(async () => {
      await repository.ensureIndexes();
      for (let i = 0; i < 3; i++) {
        const orderId = nextOrderId();
        idsA.push(orderId);
        await repository.insert(
          view(orderId, {
            customerId: OWNER_A,
            status: i === 0 ? OrderViewStatus.CONFIRMED : OrderViewStatus.PENDING,
            placedAt: new Date(Date.UTC(2026, 10, 13, 9, i)),
          }),
        );
      }
      orderOfB = nextOrderId();
      await repository.insert(view(orderOfB, { customerId: OWNER_B }));
    });

    it("should page and count only the owner's orders", async () => {
      const first = await repository.list({ customerId: OWNER_A }, { limit: 2, offset: 0 });
      const second = await repository.list({ customerId: OWNER_A }, { limit: 2, offset: 2 });

      expect(first.totalCount).toBe(3);
      expect(first.views.map((v) => v.orderId)).toEqual([idsA[2], idsA[1]]);
      expect(second.views.map((v) => v.orderId)).toEqual([idsA[0]]);
    });

    it("should count owner + status over the owner's orders only", async () => {
      const page = await repository.list(
        { customerId: OWNER_A, status: OrderViewStatus.PENDING },
        { limit: 20, offset: 0 },
      );

      expect(page.totalCount).toBe(2);
      expect(page.views.every((v) => v.customerId === OWNER_A)).toBe(true);
    });

    it.each([
      ['owner', { customerId: OWNER_A }, 'customerId_placedAt'],
      [
        'owner + status',
        { customerId: OWNER_A, status: OrderViewStatus.PENDING },
        'customerId_status_placedAt',
      ],
    ])(
      'should serve the %s list and count from an index (no COLLSCAN)',
      async (_l, q, indexName) => {
        const collection = connection.collection('order_views');
        const listPlan = await collection.find(q).sort({ placedAt: -1, _id: -1 }).explain();
        const countPlan = await connection.db!.command({
          explain: { count: 'order_views', query: q },
        });

        // The list walks the index (IXSCAN); a count may be answered from the index keys alone
        // (COUNT_SCAN). Both are index-backed; what matters is the index used and no COLLSCAN.
        for (const [plan, stage] of [
          [listPlan, 'IXSCAN'],
          [countPlan, /IXSCAN|COUNT_SCAN/],
        ] as const) {
          const winning = JSON.stringify(plan.queryPlanner.winningPlan);
          expect(winning).toMatch(stage);
          expect(winning).toContain(`"indexName":"${indexName}"`);
          expect(winning).not.toContain('COLLSCAN');
        }
      },
    );

    it('should find an order by id for its owner and for an unscoped (admin) read', async () => {
      expect((await repository.findOne(idsA[0], OWNER_A))?.orderId).toBe(idsA[0]);
      expect((await repository.findOne(orderOfB))?.orderId).toBe(orderOfB);
    });

    it("should return null for another owner's order, exactly like an unknown id", async () => {
      expect(await repository.findOne(orderOfB, OWNER_A)).toBeNull();
      expect(await repository.findOne(nextOrderId(), OWNER_A)).toBeNull();
    });

    it('should return the plain view from findOne, without the revision', async () => {
      const found = await repository.findOne(idsA[1], OWNER_A);

      expect(found).not.toHaveProperty('revision');
      expect(found?.customerId).toBe(OWNER_A);
    });
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
