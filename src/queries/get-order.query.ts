/** Query dispatched by OrdersResolver to fetch one order from the read model by id. */
export class GetOrderQuery {
  constructor(
    /** The order id (a validated UUID, any letter case). */
    public readonly orderId: string,
  ) {}
}
