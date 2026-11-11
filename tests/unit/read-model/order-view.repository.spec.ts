import { Model } from 'mongoose';
import { OrderViewRepository } from '../../../src/read-model/order-view.repository';
import { OrderViewDocument } from '../../../src/read-model/order-view.schema';
import { OrderView } from '../../../src/read-model/order-view';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import {
  OrderViewConcurrencyError,
  ReadModelUnavailableError,
} from '../../../src/read-model/errors';

const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function view(): OrderView {
  return {
    orderId: ORDER_ID,
    customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    status: OrderViewStatus.PENDING,
    items: null,
    totalAmount: null,
    placedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    updatedAt: new Date('2026-11-11T10:00:00.000Z'),
    appliedEventIds: [],
    statusEventId: null,
  };
}

function namedError(name: string, message: string, code?: number): Error {
  const error = new Error(message) as Error & { code?: number };
  error.name = name;
  if (code !== undefined) {
    error.code = code;
  }
  return error;
}

/** A Model whose `create` fails with `failure`, on a connection whose ping behaves as given. */
function repositoryWith(
  failure: Error,
  ping: 'ok' | 'fails' | 'hangs' | 'disconnected',
): OrderViewRepository {
  const command = jest.fn(() => {
    if (ping === 'fails') {
      return Promise.reject(new Error('ping failed'));
    }
    if (ping === 'hangs') {
      return new Promise(() => undefined);
    }
    return Promise.resolve({ ok: 1 });
  });
  const model = {
    create: jest.fn().mockRejectedValue(failure),
    db: {
      readyState: ping === 'disconnected' ? 0 : 1,
      db: { admin: () => ({ command }) },
    },
  } as unknown as Model<OrderViewDocument>;
  return new OrderViewRepository(model);
}

describe('OrderViewRepository error mapping', () => {
  it('should map a known connectivity error to ReadModelUnavailableError without pinging', async () => {
    const repository = repositoryWith(
      namedError('MongoServerSelectionError', 'connect ECONNREFUSED'),
      'ok',
    );

    await expect(repository.insert(view())).rejects.toThrow(ReadModelUnavailableError);
  });

  it('should treat any other error as an outage when MongoDB does not answer a ping (e.g. "Authentication failed." from a port proxy)', async () => {
    const repository = repositoryWith(
      namedError('MongoServerError', 'Authentication failed.', 18),
      'fails',
    );

    await expect(repository.insert(view())).rejects.toThrow(ReadModelUnavailableError);
  });

  it('should treat a disconnected connection as an outage', async () => {
    const repository = repositoryWith(new Error('something odd'), 'disconnected');

    await expect(repository.insert(view())).rejects.toThrow(ReadModelUnavailableError);
  });

  it('should treat a ping that times out as an outage', async () => {
    jest.useFakeTimers();
    try {
      const repository = repositoryWith(new Error('something odd'), 'hangs');

      const pending = expect(repository.insert(view())).rejects.toThrow(ReadModelUnavailableError);
      await jest.advanceTimersByTimeAsync(2_000);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it('should rethrow an error unchanged when MongoDB is reachable (a real, event-specific failure)', async () => {
    const validation = namedError('ValidationError', 'status: invalid enum value');
    const repository = repositoryWith(validation, 'ok');

    await expect(repository.insert(view())).rejects.toBe(validation);
  });

  it('should map a duplicate key on insert to OrderViewConcurrencyError when MongoDB is reachable', async () => {
    const repository = repositoryWith(
      namedError('MongoServerError', 'E11000 duplicate key', 11000),
      'ok',
    );

    await expect(repository.insert(view())).rejects.toThrow(OrderViewConcurrencyError);
  });
});
