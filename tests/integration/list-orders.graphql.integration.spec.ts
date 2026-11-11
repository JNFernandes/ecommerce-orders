import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { OrderViewRepository } from '../../src/read-model/order-view.repository';
import { OrderView } from '../../src/read-model/order-view';
import { OrderViewStatus } from '../../src/read-model/order-view-status.enum';
import { buildGraphqlTestingApp, mongoUri } from './support/read-model-testing';

jest.setTimeout(180_000);

const CUSTOMER_A = 'aaaaaaaa-0000-4000-8000-000000000000';

interface GqlError {
  message: string;
  extensions?: Record<string, unknown>;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: GqlError[];
}

interface OrderResult {
  orderId: string;
  customerId: string;
  status: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number; subtotal: number }> | null;
  totalAmount: number | null;
  placedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

interface OrdersData {
  orders: { items: OrderResult[]; totalCount: number; hasNextPage: boolean };
}

const ORDER_FIELDS = `orderId customerId status totalAmount placedAt confirmedAt cancelledAt cancellationReason
  items { productId quantity unitPrice subtotal }`;

function orderId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function view(
  n: number,
  overrides: Partial<OrderView> = {},
  placedMinute: number | null = n,
): OrderView {
  const placedAt =
    placedMinute === null ? null : new Date(Date.UTC(2026, 10, 11, 10, placedMinute, 0));
  return {
    orderId: orderId(n),
    customerId: CUSTOMER_A,
    status: OrderViewStatus.PENDING,
    items:
      placedAt === null
        ? null
        : [{ productId: `p-${n}`, quantity: 2, unitPrice: 1.5, subtotal: 3 }],
    totalAmount: placedAt === null ? null : 3,
    placedAt,
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: placedAt ?? new Date(Date.UTC(2026, 10, 11, 12, 0, 0)),
    appliedEventIds: [`e${n}`],
    statusEventId: null,
    ...overrides,
  };
}

describe('GraphQL orders query (integration, MongoDB)', () => {
  let container: StartedMongoDBContainer;
  let app: INestApplication;

  async function gql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GqlResponse<T>> {
    const response = await request(app.getHttpServer()).post('/graphql').send({ query, variables });
    return response.body as GqlResponse<T>;
  }

  async function orders(argList = ''): Promise<OrdersData['orders']> {
    const body = await gql<OrdersData>(
      `{ orders${argList ? `(${argList})` : ''} { totalCount hasNextPage items { ${ORDER_FIELDS} } } }`,
    );
    expect(body.errors).toBeUndefined();
    return (body.data as OrdersData).orders;
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    app = await buildGraphqlTestingApp(mongoUri(container.getConnectionString()));
    const repository = app.get(OrderViewRepository);
    // 1..5 placed at minutes 1..5 (5 is newest); 6 and 7 share minute 3 (tie with 3);
    // 8 has no placedAt yet (created by an early terminal event).
    const seed: OrderView[] = [
      view(1),
      view(2),
      view(3),
      view(4),
      view(5),
      view(6, {}, 3),
      view(7, {}, 3),
      view(8, { status: OrderViewStatus.CONFIRMED, confirmedAt: new Date() }, null),
    ];
    for (const v of seed) {
      await repository.insert(v);
    }
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  describe('browsing (US1)', () => {
    it('should list orders newest first, ties by orderId desc, and orders without placedAt last', async () => {
      const page = await orders();

      expect(page.totalCount).toBe(8);
      expect(page.hasNextPage).toBe(false);
      expect(page.items.map((o) => o.orderId)).toEqual([
        orderId(5),
        orderId(4),
        orderId(7),
        orderId(6),
        orderId(3),
        orderId(2),
        orderId(1),
        orderId(8),
      ]);
    });

    it('should return every exposed field, with dates as ISO strings', async () => {
      const page = await orders('limit: 1');

      expect(page.items[0]).toEqual({
        orderId: orderId(5),
        customerId: CUSTOMER_A,
        status: 'PENDING',
        totalAmount: 3,
        placedAt: '2026-11-11T10:05:00.000Z',
        confirmedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        items: [{ productId: 'p-5', quantity: 2, unitPrice: 1.5, subtotal: 3 }],
      });
    });

    it('should return null items, total and placedAt for an order known only from a terminal event', async () => {
      const page = await orders('limit: 1, offset: 7');

      expect(page.items[0]).toMatchObject({
        orderId: orderId(8),
        status: 'CONFIRMED',
        items: null,
        totalAmount: null,
        placedAt: null,
      });
    });

    it('should page through every order exactly once, with consistent totalCount and hasNextPage', async () => {
      const seen: string[] = [];
      const flags: boolean[] = [];
      for (let offset = 0; offset < 8; offset += 3) {
        const page = await orders(`limit: 3, offset: ${offset}`);
        expect(page.totalCount).toBe(8);
        seen.push(...page.items.map((o) => o.orderId));
        flags.push(page.hasNextPage);
      }

      expect(seen).toEqual((await orders()).items.map((o) => o.orderId));
      expect(new Set(seen).size).toBe(8);
      expect(flags).toEqual([true, true, false]);
    });

    it('should return an empty page with the right totalCount for an offset past the end', async () => {
      const page = await orders('offset: 50');

      expect(page.items).toEqual([]);
      expect(page.totalCount).toBe(8);
      expect(page.hasNextPage).toBe(false);
    });

    it('should not expose read-model bookkeeping fields', async () => {
      const body = await gql('{ orders { items { orderId revision } } }');

      expect(body.errors?.[0].extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });
  });
});
