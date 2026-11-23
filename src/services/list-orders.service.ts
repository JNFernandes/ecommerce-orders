import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ListOrdersQuery } from '../queries/list-orders.query';
import { OrderView } from '../read-model/order-view';
import { OrderViewRepository } from '../read-model/order-view.repository';
import { EMPTY, scopeOrderFilter } from '../read-model/order-view-scope';

/** One page of the order list. */
export interface ListOrdersResult {
  views: OrderView[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Read-path query handler: lists orders from the MongoDB read model (never the write model) and
 * works out whether another page exists. The query's scope is applied to the filter first
 * (`scopeOrderFilter`), so the page, `totalCount` and `hasNextPage` only ever cover the orders the
 * caller may read; a customer asking for another customer's orders gets an empty page without a
 * database call.
 */
@QueryHandler(ListOrdersQuery)
export class ListOrdersService implements IQueryHandler<ListOrdersQuery, ListOrdersResult> {
  constructor(private readonly repository: OrderViewRepository) {}

  async execute(query: ListOrdersQuery): Promise<ListOrdersResult> {
    const filter = scopeOrderFilter(query.scope, query.filter);
    const { views, totalCount } =
      filter === EMPTY
        ? { views: [], totalCount: 0 }
        : await this.repository.list(filter, query.page);
    return {
      views,
      totalCount,
      hasNextPage: query.page.offset + views.length < totalCount,
    };
  }
}
