import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ListOrdersQuery } from '../queries/list-orders.query';
import { OrderView } from '../read-model/order-view';
import { OrderViewRepository } from '../read-model/order-view.repository';

/** One page of the order list. */
export interface ListOrdersResult {
  views: OrderView[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Read-path query handler: lists orders from the MongoDB read model (never the write model) and
 * works out whether another page exists.
 */
@QueryHandler(ListOrdersQuery)
export class ListOrdersService implements IQueryHandler<ListOrdersQuery, ListOrdersResult> {
  constructor(private readonly repository: OrderViewRepository) {}

  async execute(query: ListOrdersQuery): Promise<ListOrdersResult> {
    const { views, totalCount } = await this.repository.list(query.filter, query.page);
    return {
      views,
      totalCount,
      hasNextPage: query.page.offset + views.length < totalCount,
    };
  }
}
