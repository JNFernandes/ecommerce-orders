/**
 * Outcome of the stock reservation for an order, as announced by the Inventory service. An
 * order starts with `PENDING`; a consumed stock message is always `RESERVED` or `REJECTED`.
 */
export enum StockOutcome {
  /** No stock outcome has been received for the order yet. */
  PENDING = 'PENDING',
  /** Every item of the order was reserved (`inventory.stock-reserved`). */
  RESERVED = 'RESERVED',
  /** At least one item could not be reserved, so nothing was (`inventory.stock-rejected`). */
  REJECTED = 'REJECTED',
}
