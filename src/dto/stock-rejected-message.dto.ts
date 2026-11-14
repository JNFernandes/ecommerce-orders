import { Equals, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Inbound `inventory.stock-rejected` message (published by ecommerce-inventory, contract in
 * ecommerce-infra/docs/events.md). Only the fields Orders uses are validated; the others are
 * accepted and ignored. See docs/events/stock-rejected.md.
 */
export class StockRejectedMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** The reservation id. NOT an order id: stored for audit only. */
  @IsUUID()
  aggregateId!: string;

  /** When the event was raised (ISO 8601). */
  @IsISO8601()
  occurredAt!: string;

  /** Schema version; only `1` is supported. */
  @Equals(1)
  version!: number;

  /** The order whose stock was rejected. */
  @IsUUID()
  orderId!: string;

  /**
   * Why the reservation was rejected (`insufficient stock`, `unknown product`, or
   * `unknown product and insufficient stock`). Orders does not restrict the value; it becomes
   * the order's cancellation reason as `stock rejected: <reason>`.
   */
  @IsOptional()
  @IsString()
  reason?: string | null;

  /** The items that could not be reserved (not used). */
  items?: unknown;

  /** When the stock was rejected (not used). */
  rejectedAt?: unknown;
}
