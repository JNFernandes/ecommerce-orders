import { Equals, IsISO8601, IsUUID } from 'class-validator';

/**
 * Inbound `inventory.stock-reserved` message (published by ecommerce-inventory, contract in
 * ecommerce-infra/docs/events.md). Only the fields Orders uses are validated; the others are
 * accepted and ignored. See docs/events/stock-reserved.md.
 */
export class StockReservedMessageDto {
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

  /** The order whose stock was reserved. */
  @IsUUID()
  orderId!: string;

  /** The reserved items, one per product (not used). */
  items?: unknown;

  /** When the stock was reserved (not used). */
  reservedAt?: unknown;
}
