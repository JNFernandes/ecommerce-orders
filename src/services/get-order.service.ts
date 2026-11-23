import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { GetOrderQuery } from '../queries/get-order.query';
import { OrderView } from '../read-model/order-view';
import { OrderViewRepository } from '../read-model/order-view.repository';
import { scopeOwner } from '../read-model/order-view-scope';

/**
 * Read-path query handler: fetches one order from the MongoDB read model (never the write model)
 * by its id, or null when no view exists — "not found" is a normal answer, not an error. The id is
 * lower-cased because UUIDs are case-insensitive and stored order ids are lowercase. A customer's
 * lookup also matches the owner in the same query, so another customer's order is `null`, exactly
 * like an unknown id (no existence leak).
 */
@QueryHandler(GetOrderQuery)
export class GetOrderService implements IQueryHandler<GetOrderQuery, OrderView | null> {
  constructor(private readonly repository: OrderViewRepository) {}

  async execute(query: GetOrderQuery): Promise<OrderView | null> {
    return this.repository.findOne(query.orderId.toLowerCase(), scopeOwner(query.scope));
  }
}
