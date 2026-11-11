import { Equals, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Inbound `payments.payment-failed` message. Only the fields Orders uses are validated;
 * other contract fields are accepted and ignored. See docs/events/payment-failed.md.
 */
export class PaymentFailedMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** The payment id. NOT an order id. */
  @IsUUID()
  aggregateId!: string;

  /** Schema version; only `1` is supported. */
  @Equals(1)
  version!: number;

  /** The order this payment was for. */
  @IsUUID()
  orderId!: string;

  /** Human-readable failure reason (free text); stored as the order's cancellation reason. */
  @IsOptional()
  @IsString()
  reason?: string | null;

  /** When the event was raised (not used). */
  occurredAt?: string;

  /** When the payment failed (not used). */
  failedAt?: string;
}
