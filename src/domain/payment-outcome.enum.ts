/** Outcome of a payment, as announced by the Payments service. */
export enum PaymentOutcome {
  /** The payment succeeded (`payments.payment-processed`). */
  PROCESSED = 'PROCESSED',
  /** The payment failed (`payments.payment-failed`). */
  FAILED = 'FAILED',
}
