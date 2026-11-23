import { OrderViewFilter, PageRequest } from '../read-model/order-view.repository';
import { OrderReadScope } from './order-read-scope';

/** Query dispatched by OrdersResolver to list orders from the read model. */
export class ListOrdersQuery {
  constructor(
    /** Which orders the caller may read (required: an unscoped read cannot be written). */
    public readonly scope: OrderReadScope,
    /** Optional status / customer filters (AND), as requested; narrowed by `scope`. */
    public readonly filter: OrderViewFilter,
    /** Validated page size and offset. */
    public readonly page: PageRequest,
  ) {}
}
