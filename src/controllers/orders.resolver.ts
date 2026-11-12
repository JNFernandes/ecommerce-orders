import { UseFilters } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@nestjs/cqrs';
import { OrderType } from '../dto/graphql/order.type';
import { OrdersPageType } from '../dto/graphql/orders-page.type';
import { ListOrdersArgs } from '../dto/graphql/list-orders.args';
import { GetOrderArgs } from '../dto/graphql/get-order.args';
import { GetOrderQuery } from '../queries/get-order.query';
import { OrderView } from '../read-model/order-view';
import { ListOrdersQuery } from '../queries/list-orders.query';
import { ListOrdersResult } from '../services/list-orders.service';
import { OrderViewFilter } from '../read-model/order-view.repository';
import { GraphQLUserInputFilter } from '../graphql/graphql-user-input.filter';

/**
 * GraphQL read path (CQRS query side): validates arguments, dispatches exactly one query on the
 * QueryBus and shapes the read-model result into GraphQL types. No business logic, no commands,
 * no write-model access. Invalid arguments surface as BAD_USER_INPUT and read-model outages as
 * SERVICE_UNAVAILABLE (GraphQLUserInputFilter).
 */
@Resolver(() => OrderType)
@UseFilters(GraphQLUserInputFilter)
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

  @Query(() => OrderType, {
    name: 'order',
    nullable: true,
    description:
      'Gets one order from the read model by id, or null when no order has that id. ' +
      'Eventually consistent: an order that was just placed may briefly return null until it ' +
      'has been projected.',
  })
  async order(@Args() args: GetOrderArgs): Promise<OrderType | null> {
    const view = await this.queryBus.execute<GetOrderQuery, OrderView | null>(
      new GetOrderQuery(args.orderId),
    );
    return view ? OrderType.fromView(view) : null;
  }
}
