/**
 * Outcome of an order's payment, as announced by the Payments service. An order starts with
 * `PENDING`; a consumed payment message is always `PROCESSED` or `FAILED`.
 */
export enum PaymentOutcome {
  /** No payment outcome has been received for the order yet. */
  PENDING = 'PENDING',
  /** The payment succeeded (`payments.payment-processed`). */
  PROCESSED = 'PROCESSED',
  /** The payment failed (`payments.payment-failed`). */
  FAILED = 'FAILED',
}
