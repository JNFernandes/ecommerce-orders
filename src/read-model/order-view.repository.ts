import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrderView, StoredOrderView } from './order-view';
import { OrderViewDocument } from './order-view.schema';
import { OrderViewConcurrencyError } from './errors';

const MONGO_DUPLICATE_KEY = 11000;

/** Raw document shape as read back with `lean()`. */
type StoredDocument = OrderViewDocument;

/**
 * Persists order views in MongoDB (`order_views`). Writes whole documents with optimistic
 * concurrency on `revision`, so applying an event and recording its id is one atomic write.
 */
@Injectable()
export class OrderViewRepository {
  constructor(
    @InjectModel(OrderViewDocument.name)
    private readonly model: Model<OrderViewDocument>,
  ) {}

  /** Loads a view and its revision, or null when the order has no view yet. */
  async findById(orderId: string): Promise<StoredOrderView | null> {
    const document = await this.model.findById(orderId).lean<StoredDocument>().exec();
    return document ? { view: toView(document), revision: document.revision } : null;
  }

  /**
   * Creates the view at revision 1.
   *
   * @throws OrderViewConcurrencyError if another writer created it first.
   */
  async insert(view: OrderView): Promise<void> {
    try {
      await this.model.create({ _id: view.orderId, ...view, revision: 1 });
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
   */
  async replace(view: OrderView, expectedRevision: number): Promise<void> {
    const result = await this.model
      .replaceOne(
        { _id: view.orderId, revision: expectedRevision },
        { _id: view.orderId, ...view, revision: expectedRevision + 1 },
      )
      .exec();
    if (result.matchedCount === 0) {
      throw new OrderViewConcurrencyError(view.orderId);
    }
  }
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
