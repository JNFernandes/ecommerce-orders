import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrderView, StoredOrderView } from './order-view';
import { OrderViewDocument } from './order-view.schema';
import { OrderViewConcurrencyError, ReadModelUnavailableError } from './errors';

const MONGO_DUPLICATE_KEY = 11000;

/** Driver / Mongoose error names that mean "MongoDB is unreachable", not "this event is bad". */
const CONNECTIVITY_ERROR_NAMES: ReadonlySet<string> = new Set([
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoPoolClearedError',
]);

/** Mongoose's fail-fast errors when `bufferCommands` is off and there is no connection. */
const NOT_CONNECTED_MESSAGE =
  /before initial connection is complete|not connected|connection .*closed/i;

/** How long the reachability check may take before MongoDB is considered unavailable. */
const PING_TIMEOUT_MS = 2_000;

/** Raw document shape as read back with `lean()`. */
type StoredDocument = OrderViewDocument;

/**
 * Persists order views in MongoDB (`order_views`). Writes whole documents with optimistic
 * concurrency on `revision`, so applying an event and recording its id is one atomic write.
 * Connectivity failures surface as ReadModelUnavailableError so callers never inspect driver
 * internals: known connectivity errors are mapped directly, and for any other error the
 * repository pings MongoDB — if the ping fails, the store is down (not the event at fault).
 */
@Injectable()
export class OrderViewRepository {
  constructor(
    @InjectModel(OrderViewDocument.name)
    private readonly model: Model<OrderViewDocument>,
  ) {}

  /**
   * Loads a view and its revision, or null when the order has no view yet.
   *
   * @throws ReadModelUnavailableError when MongoDB is unreachable.
   */
  async findById(orderId: string): Promise<StoredOrderView | null> {
    const document = await this.guard(() =>
      this.model.findById(orderId).lean<StoredDocument>().exec(),
    );
    return document ? { view: toView(document), revision: document.revision } : null;
  }

  /**
   * Creates the view at revision 1.
   *
   * @throws OrderViewConcurrencyError if another writer created it first.
   * @throws ReadModelUnavailableError when MongoDB is unreachable.
   */
  async insert(view: OrderView): Promise<void> {
    try {
      await this.guard(() => this.model.create({ _id: view.orderId, ...view, revision: 1 }));
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new OrderViewConcurrencyError(view.orderId);
      }
      throw error;
    }
  }

  /**
   * Replaces the view if it is still at `expectedRevision`, bumping the revision.
   *
   * @throws OrderViewConcurrencyError if the stored revision changed in the meantime.
   * @throws ReadModelUnavailableError when MongoDB is unreachable.
   */
  async replace(view: OrderView, expectedRevision: number): Promise<void> {
    const result = await this.guard(() =>
      this.model
        .replaceOne(
          { _id: view.orderId, revision: expectedRevision },
          { _id: view.orderId, ...view, revision: expectedRevision + 1 },
        )
        .exec(),
    );
    if (result.matchedCount === 0) {
      throw new OrderViewConcurrencyError(view.orderId);
    }
  }

  /**
   * Runs a MongoDB operation, translating outages into ReadModelUnavailableError. Driver errors
   * during an outage are not always connectivity errors (e.g. a port proxy accepting the TCP
   * connection makes the handshake fail with "Authentication failed"), so any other error is
   * double-checked with a ping before it is treated as a real, event-specific failure.
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isConnectivityError(error) || !(await this.isReachable())) {
        throw new ReadModelUnavailableError(error);
      }
      throw error;
    }
  }

  /** True when MongoDB answers a ping within PING_TIMEOUT_MS. */
  private async isReachable(): Promise<boolean> {
    const connection = this.model.db;
    if (connection.readyState !== 1 || !connection.db) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        connection.db.admin().command({ ping: 1 }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    CONNECTIVITY_ERROR_NAMES.has(error.name) ||
    (error.name === 'MongooseError' && NOT_CONNECTED_MESSAGE.test(error.message))
  );
}

function toView(document: StoredDocument): OrderView {
  return {
    orderId: document.orderId,
    customerId: document.customerId,
    status: document.status,
    items:
      document.items?.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
      })) ?? null,
    totalAmount: document.totalAmount ?? null,
    placedAt: document.placedAt ?? null,
    confirmedAt: document.confirmedAt ?? null,
    cancelledAt: document.cancelledAt ?? null,
    cancellationReason: document.cancellationReason ?? null,
    updatedAt: document.updatedAt,
    appliedEventIds: [...document.appliedEventIds],
    statusEventId: document.statusEventId ?? null,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}
