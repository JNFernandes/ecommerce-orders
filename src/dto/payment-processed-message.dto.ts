import { Equals, IsUUID } from 'class-validator';

/**
 * Inbound `payments.payment-processed` message. Only the fields Orders uses are validated;
 * other contract fields are accepted and ignored. See docs/events/payment-processed.md.
 */
export class PaymentProcessedMessageDto {
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

  /** When the event was raised (not used). */
  occurredAt?: string;

  /** Amount charged (not used). */
  amount?: number;

  /** ISO 4217 currency (not used). */
  currency?: string;

  /** When the payment was processed (not used). */
  processedAt?: string;
}
