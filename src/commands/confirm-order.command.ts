/**
 * Command to confirm a pending order manually, dispatched by OrdersController (REST). An
 * operator override: it confirms any PENDING order whatever its payment and stock outcomes
 * (US-09, FR-020). Outcome-driven confirmation goes through ApplyPaymentOutcomeCommand /
 * ApplyStockOutcomeCommand instead.
 */
export class ConfirmOrderCommand {
  constructor(public readonly orderId: string) {}
}
