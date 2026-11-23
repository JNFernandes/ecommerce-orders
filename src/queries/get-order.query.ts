import { OrderReadScope } from './order-read-scope';

/** Query dispatched by OrdersResolver to fetch one order from the read model by id. */
export class GetOrderQuery {
  constructor(
    /** Which orders the caller may read (required: an unscoped read cannot be written). */
    public readonly scope: OrderReadScope,
    /** The order id (a validated UUID, any letter case). */
    public readonly orderId: string,
  ) {}
}
