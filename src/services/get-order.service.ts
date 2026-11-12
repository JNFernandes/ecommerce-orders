import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { GetOrderQuery } from '../queries/get-order.query';
import { OrderView } from '../read-model/order-view';
import { OrderViewRepository } from '../read-model/order-view.repository';

/**
 * Read-path query handler: fetches one order from the MongoDB read model (never the write model)
 * by its id, or null when no view exists — "not found" is a normal answer, not an error. The id is
 * lower-cased because UUIDs are case-insensitive and stored order ids are lowercase.
 */
@QueryHandler(GetOrderQuery)
export class GetOrderService implements IQueryHandler<GetOrderQuery, OrderView | null> {
  constructor(private readonly repository: OrderViewRepository) {}

  async execute(query: GetOrderQuery): Promise<OrderView | null> {
    const stored = await this.repository.findById(query.orderId.toLowerCase());
    return stored?.view ?? null;
  }
}
