import { OrderRequester } from '../domain/order-requester';

/**
 * Command to cancel a pending order, dispatched by OrdersController (REST). The cancellation
 * carries no reason and leaves the order's payment and stock outcomes unchanged (US-09,
 * FR-021). Outcome-driven cancellation goes through ApplyPaymentOutcomeCommand /
 * ApplyStockOutcomeCommand instead.
 */
export class CancelOrderCommand {
  /**
   * @param orderId The order to cancel.
   * @param requester Who asks; a customer may cancel only their own orders (US-11).
   */
  constructor(
    public readonly orderId: string,
    public readonly requester: OrderRequester,
  ) {}
}
