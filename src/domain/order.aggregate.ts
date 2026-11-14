import { randomUUID } from 'crypto';
import { OrderStatus } from './order-status.enum';
import { OrderItem } from './order-item.value-object';
import { OrderPlaced } from './events/order-placed.event';
import { OrderCancelled } from './events/order-cancelled.event';
import { OrderConfirmed } from './events/order-confirmed.event';
import { OrderValidationError } from './order-validation.error';
import { OrderCancellationError } from './order-cancellation.error';
import { OrderConfirmationError } from './order-confirmation.error';
import { PaymentOutcome } from './payment-outcome.enum';
import { StockOutcome } from './stock-outcome.enum';
import { Attention, OutcomeApplication, OutcomeRecord } from './outcome-application';

export interface RawOrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export type OrderDomainEvent = OrderPlaced | OrderCancelled | OrderConfirmed;

/**
 * Order is the aggregate root for a customer's purchase request. All business rules
 * for placing, cancelling, etc. an order live here and nowhere else — this class has
 * no I/O and no framework dependencies.
 */
export class Order {
  private readonly domainEvents: OrderDomainEvent[] = [];

  private constructor(
    public readonly id: string,
    public readonly customerId: string,
    public status: OrderStatus,
    public readonly items: OrderItem[],
    public readonly totalAmount: number,
    public readonly createdAt: Date,
    public updatedAt: Date,
    /**
     * Why the order was cancelled, when a reason was given (payment failure or stock
     * rejection); otherwise null.
     */
    public cancellationReason: string | null = null,
    /** The payment outcome received so far (`PENDING` until Payments announces one). */
    public paymentOutcome: PaymentOutcome = PaymentOutcome.PENDING,
    /** The stock outcome received so far (`PENDING` until Inventory announces one). */
    public stockOutcome: StockOutcome = StockOutcome.PENDING,
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

  /**
   * Cancels a pending order. Only a PENDING order can be cancelled — attempting to
   * cancel an order that is already CONFIRMED or already CANCELLED raises
   * OrderCancellationError instead of silently succeeding.
   *
   * @param reason Why the order is cancelled (e.g. the payment failure reason). Omitted for
   *   cancellations requested through the REST endpoint.
   */
  cancel(reason?: string): void {
    if (this.status !== OrderStatus.PENDING) {
      throw new OrderCancellationError(
        `cannot cancel order with status ${this.status}; only a PENDING order can be cancelled`,
      );
    }

    this.status = OrderStatus.CANCELLED;
    this.updatedAt = new Date();
    this.cancellationReason = reason ?? null;
    this.domainEvents.push(OrderCancelled.from(this));
  }

  /**
   * Confirms a pending order (e.g. after payment has been processed). Only a PENDING
   * order can be confirmed — attempting to confirm an order that is already CONFIRMED
   * or already CANCELLED raises OrderConfirmationError instead of silently succeeding.
   */
  confirm(): void {
    if (this.status !== OrderStatus.PENDING) {
      throw new OrderConfirmationError(
        `cannot confirm order with status ${this.status}; only a PENDING order can be confirmed`,
      );
    }

    this.markConfirmed();
  }

  /**
   * Records that the payment for this order succeeded (`payments.payment-processed`). On a
   * PENDING order it confirms the order when the stock is already reserved, and otherwise
   * records the outcome and waits for the stock. Never throws.
   */
  recordPaymentProcessed(): OutcomeApplication {
    if (this.paymentOutcome === PaymentOutcome.PROCESSED) {
      return { record: OutcomeRecord.IGNORED_DUPLICATE, attention: Attention.NONE };
    }

    this.paymentOutcome = PaymentOutcome.PROCESSED;
    return this.confirmIfBothPositive();
  }

  /**
   * Records that the stock for this order was reserved (`inventory.stock-reserved`). On a
   * PENDING order it confirms the order when the payment is already processed, and otherwise
   * records the outcome and waits for the payment. Never throws.
   */
  recordStockReserved(): OutcomeApplication {
    if (this.stockOutcome === StockOutcome.RESERVED) {
      return { record: OutcomeRecord.IGNORED_DUPLICATE, attention: Attention.NONE };
    }

    this.stockOutcome = StockOutcome.RESERVED;
    return this.confirmIfBothPositive();
  }

  /** Confirms the order once both outcomes are positive; otherwise only refreshes updatedAt. */
  private confirmIfBothPositive(): OutcomeApplication {
    if (
      this.paymentOutcome === PaymentOutcome.PROCESSED &&
      this.stockOutcome === StockOutcome.RESERVED
    ) {
      this.markConfirmed();
      return { record: OutcomeRecord.CONFIRMED, attention: Attention.NONE };
    }

    this.updatedAt = new Date();
    return { record: OutcomeRecord.RECORDED, attention: Attention.NONE };
  }

  /** The PENDING → CONFIRMED transition shared by confirm() and the outcome methods. */
  private markConfirmed(): void {
    this.status = OrderStatus.CONFIRMED;
    this.updatedAt = new Date();
    this.domainEvents.push(OrderConfirmed.from(this));
  }

  /**
   * Reconstructs an Order from persisted state, without raising domain events. The outcomes
   * default to `PENDING` when not given.
   */
  static reconstitute(
    id: string,
    customerId: string,
    status: OrderStatus,
    items: OrderItem[],
    totalAmount: number,
    createdAt: Date,
    updatedAt: Date,
    cancellationReason: string | null = null,
    paymentOutcome: PaymentOutcome = PaymentOutcome.PENDING,
    stockOutcome: StockOutcome = StockOutcome.PENDING,
  ): Order {
    return new Order(
      id,
      customerId,
      status,
      items,
      totalAmount,
      createdAt,
      updatedAt,
      cancellationReason,
      paymentOutcome,
      stockOutcome,
    );
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
  pullDomainEvents(): OrderDomainEvent[] {
    const events = [...this.domainEvents];
    this.domainEvents.length = 0;
    return events;
  }
}
