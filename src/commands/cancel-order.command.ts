/** Command dispatched by OrdersController to cancel a pending order. */
export class CancelOrderCommand {
  constructor(public readonly orderId: string) {}
}
