import { OrderViewFilter, PageRequest } from '../read-model/order-view.repository';

/** Query dispatched by OrdersResolver to list orders from the read model. */
export class ListOrdersQuery {
  constructor(
    /** Optional status / customer filters (AND). */
    public readonly filter: OrderViewFilter,
    /** Validated page size and offset. */
    public readonly page: PageRequest,
  ) {}
}
