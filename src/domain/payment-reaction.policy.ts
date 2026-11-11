import { OrderStatus } from './order-status.enum';
import { PaymentOutcome } from './payment-outcome.enum';

/** What the Orders service must do with an order when a payment outcome arrives. */
export enum PaymentReaction {
  /** PENDING order, payment succeeded: confirm it. */
  CONFIRM = 'CONFIRM',
  /** PENDING order, payment failed: cancel it. */
  CANCEL = 'CANCEL',
  /** Already CONFIRMED and the payment succeeded: nothing to do. */
  ALREADY_CONFIRMED = 'ALREADY_CONFIRMED',
  /** Already CANCELLED and the payment failed: nothing to do. */
  ALREADY_CANCELLED = 'ALREADY_CANCELLED',
  /**
   * The order is in the opposite final state (CANCELLED + succeeded, or CONFIRMED + failed):
   * leave it unchanged and raise a warning. Refunds are a Payments concern.
   */
  CONFLICT = 'CONFLICT',
}

/**
 * Business rule for the order/payment saga: given an order's current status and the payment
 * outcome, decides the reaction. Pure — no I/O, no framework.
 *
 * | status    | PROCESSED         | FAILED            |
 * |-----------|-------------------|-------------------|
 * | PENDING   | CONFIRM           | CANCEL            |
 * | CONFIRMED | ALREADY_CONFIRMED | CONFLICT          |
 * | CANCELLED | CONFLICT          | ALREADY_CANCELLED |
 */
export function decidePaymentReaction(
  status: OrderStatus,
  outcome: PaymentOutcome,
): PaymentReaction {
  switch (status) {
    case OrderStatus.PENDING:
      return outcome === PaymentOutcome.PROCESSED
        ? PaymentReaction.CONFIRM
        : PaymentReaction.CANCEL;
    case OrderStatus.CONFIRMED:
      return outcome === PaymentOutcome.PROCESSED
        ? PaymentReaction.ALREADY_CONFIRMED
        : PaymentReaction.CONFLICT;
    case OrderStatus.CANCELLED:
      return outcome === PaymentOutcome.FAILED
        ? PaymentReaction.ALREADY_CANCELLED
        : PaymentReaction.CONFLICT;
  }
}
