import { Equals, IsISO8601, IsUUID } from 'class-validator';

/**
 * Inbound `orders.order-confirmed` message as consumed by the read-model projection.
 * Read-side DTO, separate from the write-side OrderConfirmed domain event class.
 * See docs/events/order-confirmed.md.
 */
export class OrderConfirmedMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** When the order was confirmed. */
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
}
