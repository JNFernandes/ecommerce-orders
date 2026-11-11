import { Field, Int, ObjectType } from '@nestjs/graphql';
import { OrderType } from './order.type';

/** GraphQL `OrdersPage`: one page of the `orders` query. */
@ObjectType('OrdersPage', { description: 'One page of orders, with paging information.' })
export class OrdersPageType {
  @Field(() => [OrderType], {
    description: 'Orders on this page, newest first (orders without a placement time last).',
  })
  items!: OrderType[];

  @Field(() => Int, { description: 'Number of orders matching the filters, ignoring paging.' })
  totalCount!: number;

  @Field(() => Boolean, { description: 'Whether more orders exist after this page.' })
  hasNextPage!: boolean;
}
