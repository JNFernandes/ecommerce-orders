export interface PlaceOrderCommandItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

/** Command dispatched by OrdersController to place a new order. */
export class PlaceOrderCommand {
  constructor(
    public readonly customerId: string,
    public readonly items: PlaceOrderCommandItem[],
  ) {}
}
