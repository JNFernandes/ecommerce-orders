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
import { Role } from '../infra/auth/role.enum';
import { Roles } from './auth/roles.decorator';
import { CurrentUser } from './auth/current-user.decorator';
import { AccessTokenClaims } from '../infra/auth/access-token-claims';
import { OrderReadScope } from '../queries/order-read-scope';

/**
 * GraphQL read path (CQRS query side): validates arguments, dispatches exactly one query on the
 * QueryBus and shapes the read-model result into GraphQL types. No business logic, no commands,
 * no write-model access. Invalid arguments surface as BAD_USER_INPUT, read-model outages as
 * SERVICE_UNAVAILABLE and callers without a read scope as FORBIDDEN (GraphQLUserInputFilter).
 * Open to `CUSTOMER` and `ADMIN` callers; every query carries the caller's
 * {@link OrderReadScope} (US-12), which the query handlers apply — no filtering happens here.
 */
@Resolver(() => OrderType)
@Roles(Role.CUSTOMER, Role.ADMIN)
@UseFilters(GraphQLUserInputFilter)
export class OrdersResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Query(() => OrdersPageType, {
    name: 'orders',
    description:
      'Lists orders from the read model, newest first (orders without a placement time last). ' +
      'Scoped to the caller: an ADMIN sees every order; a CUSTOMER sees only their own, and ' +
      'totalCount and hasNextPage count only those. Eventually consistent: a just-placed order ' +
      'may take a moment to appear.',
  })
  async orders(
    @Args() args: ListOrdersArgs,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<OrdersPageType> {
    const scope = OrderReadScope.forCaller(user);
    const filter: OrderViewFilter = {};
    if (args.status !== undefined) {
      filter.status = args.status;
    }
    if (args.customerId !== undefined) {
      filter.customerId = args.customerId;
    }
    const result = await this.queryBus.execute<ListOrdersQuery, ListOrdersResult>(
      new ListOrdersQuery(scope, filter, { limit: args.limit, offset: args.offset }),
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
      'Scoped to the caller: an ADMIN can open any order; a CUSTOMER gets null for another ' +
      "customer's order, exactly as for an unknown id. Eventually consistent: an order that was " +
      'just placed may briefly return null until it has been projected.',
  })
  async order(
    @Args() args: GetOrderArgs,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<OrderType | null> {
    const scope = OrderReadScope.forCaller(user);
    const view = await this.queryBus.execute<GetOrderQuery, OrderView | null>(
      new GetOrderQuery(scope, args.orderId),
    );
    return view ? OrderType.fromView(view) : null;
  }
}
