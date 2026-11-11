import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

/** GraphQL `OrderItem`: one line of an order. */
@ObjectType('OrderItem', { description: 'One line of an order.' })
export class OrderItemType {
  @Field(() => String, { description: 'Product identifier.' })
  productId!: string;

  @Field(() => Int, { description: 'Number of units ordered.' })
  quantity!: number;

  @Field(() => Float, { description: 'Price of one unit.' })
  unitPrice!: number;

  @Field(() => Float, { description: 'quantity × unitPrice, rounded to 2 decimals.' })
  subtotal!: number;
}
