/**
 * What applying a payment or stock outcome did to an order. Decided by the Order aggregate
 * (`record*()` methods); the application layer stores it as is, as the processed-event outcome.
 */
export enum OutcomeRecord {
  /** First positive outcome stored; the order stays PENDING and no event is raised. */
  RECORDED = 'RECORDED',
  /** Both outcomes are now positive: the order was confirmed and OrderConfirmed raised. */
  CONFIRMED = 'CONFIRMED',
  /** A negative outcome arrived: the order was cancelled and OrderCancelled raised. */
  CANCELLED = 'CANCELLED',
  /** The same outcome was already recorded on this PENDING order: nothing changed. */
  IGNORED_DUPLICATE = 'IGNORED_DUPLICATE',
  /** The order is already CONFIRMED and the outcome agrees with that: nothing changed. */
  IGNORED_ALREADY_CONFIRMED = 'IGNORED_ALREADY_CONFIRMED',
  /** The order is already CANCELLED and the outcome needs no action: nothing changed. */
  IGNORED_ALREADY_CANCELLED = 'IGNORED_ALREADY_CANCELLED',
  /**
   * The outcome contradicts the order's final status or an outcome already recorded for the
   * same side: nothing changed, and an operator should look at it.
   */
  IGNORED_CONFLICT = 'IGNORED_CONFLICT',
}

/** Whether an ignored outcome needs an operator's attention, and why. */
export enum Attention {
  /** Nothing to look at. Always the value for a record that changed the order. */
  NONE = 'NONE',
  /** A payment succeeded for an order that is already CANCELLED: the payment needs a refund. */
  REFUND_NEEDED = 'REFUND_NEEDED',
  /** The outcome contradicts the order's status or a recorded outcome. */
  CONFLICT = 'CONFLICT',
}

/** The result of `Order.record*()`: what was done, and whether it needs attention. */
export interface OutcomeApplication {
  /** What happened to the order; stored as the processed-event outcome. */
  readonly record: OutcomeRecord;
  /** `NONE` unless the outcome was ignored and an operator should look at it. */
  readonly attention: Attention;
}
