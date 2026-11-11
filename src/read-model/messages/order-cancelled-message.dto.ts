import { Equals, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Inbound `orders.order-cancelled` message as consumed by the read-model projection.
 * Read-side DTO, separate from the write-side OrderCancelled domain event class.
 * See docs/events/order-cancelled.md.
 */
export class OrderCancelledMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** When the order was cancelled. */
  @IsISO8601()
  occurredAt!: string;

  /** The order id. */
  @IsUUID()
  aggregateId!: string;

  /** Schema version; only `1` is supported. */
  @Equals(1)
  version!: number;

  /** The customer who owns the order. */
  @IsUUID()
  customerId!: string;

  /** Why the order was cancelled (optional; may be ''). */
  @IsOptional()
  @IsString()
  reason?: string | null;
}
