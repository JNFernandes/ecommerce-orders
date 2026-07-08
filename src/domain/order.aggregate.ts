import { randomUUID } from 'crypto';
import { OrderStatus } from './order-status.enum';
import { OrderItem } from './order-item.value-object';
import { OrderPlaced } from './events/order-placed.event';
import { OrderValidationError } from './order-validation.error';

export interface RawOrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Order is the aggregate root for a customer's purchase request. All business rules
 * for placing an order (consolidation, validation, total calculation) live here and
 * nowhere else — this class has no I/O and no framework dependencies.
 */
export class Order {
  private readonly domainEvents: OrderPlaced[] = [];

  private constructor(
    public readonly id: string,
    public readonly customerId: string,
    public readonly status: OrderStatus,
    public readonly items: OrderItem[],
    public readonly totalAmount: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /**
   * Places a new order: validates and consolidates items, computes the total,
   * and raises an OrderPlaced domain event.
   */
  static place(customerId: string, rawItems: RawOrderItem[]): Order {
    if (!rawItems || rawItems.length === 0) {
      throw new OrderValidationError('items must not be empty');
    }

    for (const raw of rawItems) {
      if (!raw.productId) {
        throw new OrderValidationError('productId is required for every item');
      }
      if (!Number.isInteger(raw.quantity) || raw.quantity <= 0) {
        throw new OrderValidationError('quantity must be greater than 0');
      }
      if (typeof raw.unitPrice !== 'number' || raw.unitPrice <= 0) {
        throw new OrderValidationError('unitPrice must be greater than 0');
      }
    }

    const items = Order.consolidate(rawItems).map((item) =>
      OrderItem.create(item.productId, item.quantity, item.unitPrice),
    );

    const totalAmount = Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;

    const now = new Date();
    const order = new Order(
      randomUUID(),
      customerId,
      OrderStatus.PENDING,
      items,
      totalAmount,
      now,
      now,
    );

    order.domainEvents.push(OrderPlaced.from(order));
    return order;
  }

  /** Reconstructs an Order from persisted state, without raising domain events. */
  static reconstitute(
    id: string,
    customerId: string,
    status: OrderStatus,
    items: OrderItem[],
    totalAmount: number,
    createdAt: Date,
    updatedAt: Date,
  ): Order {
    return new Order(id, customerId, status, items, totalAmount, createdAt, updatedAt);
  }

  /** Combines items referencing the same productId into one entry with summed quantity. */
  private static consolidate(rawItems: RawOrderItem[]): RawOrderItem[] {
    const consolidated = new Map<string, RawOrderItem>();
    for (const raw of rawItems) {
      const existing = consolidated.get(raw.productId);
      if (existing) {
        existing.quantity += raw.quantity;
      } else {
        consolidated.set(raw.productId, { ...raw });
      }
    }
    return Array.from(consolidated.values());
  }

  /** Drains and returns the domain events raised by this aggregate. */
  pullDomainEvents(): OrderPlaced[] {
    const events = [...this.domainEvents];
    this.domainEvents.length = 0;
    return events;
  }
}
