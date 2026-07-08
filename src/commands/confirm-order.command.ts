/** Command dispatched by OrdersController to confirm a pending order (e.g. after payment). */
export class ConfirmOrderCommand {
  constructor(public readonly orderId: string) {}
}
