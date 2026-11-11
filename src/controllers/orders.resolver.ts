import { Args, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@nestjs/cqrs';
import { OrderType } from '../dto/graphql/order.type';
import { OrdersPageType } from '../dto/graphql/orders-page.type';
import { ListOrdersArgs } from '../dto/graphql/list-orders.args';
import { ListOrdersQuery } from '../queries/list-orders.query';
import { ListOrdersResult } from '../services/list-orders.service';
import { OrderViewFilter } from '../read-model/order-view.repository';

/**
 * GraphQL read path (CQRS query side): validates arguments, dispatches exactly one query on the
 * QueryBus and shapes the read-model result into GraphQL types. No business logic, no commands,
 * no write-model access.
 */
@Resolver(() => OrderType)
export class OrdersResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Query(() => OrdersPageType, {
    name: 'orders',
    description:
      'Lists orders from the read model, newest first (orders without a placement time last). ' +
      'Eventually consistent: a just-placed order may take a moment to appear.',
  })
  async orders(@Args() args: ListOrdersArgs): Promise<OrdersPageType> {
    const filter: OrderViewFilter = {};
    if (args.status !== undefined) {
      filter.status = args.status;
    }
    if (args.customerId !== undefined) {
      filter.customerId = args.customerId;
    }
    const result = await this.queryBus.execute<ListOrdersQuery, ListOrdersResult>(
      new ListOrdersQuery(filter, { limit: args.limit, offset: args.offset }),
    );
    const page = new OrdersPageType();
    page.items = result.views.map((view) => OrderType.fromView(view));
    page.totalCount = result.totalCount;
    page.hasNextPage = result.hasNextPage;
    return page;
  }
}
