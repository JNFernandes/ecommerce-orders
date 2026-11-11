import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { OrderViewStatus } from '../../read-model/order-view-status.enum';
import './order-status.enum';

/** Maximum page size of the `orders` query. */
export const MAX_ORDERS_PAGE_SIZE = 100;

/** Arguments of the `orders` query, validated by the global ValidationPipe. */
@ArgsType()
export class ListOrdersArgs {
  @Field(() => OrderViewStatus, { nullable: true, description: 'Only orders in this status.' })
  @IsOptional()
  @IsEnum(OrderViewStatus)
  status?: OrderViewStatus;

  @Field(() => ID, { nullable: true, description: 'Only orders of this customer (UUID).' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @Field(() => Int, {
    defaultValue: 20,
    description: `Page size, 1–${MAX_ORDERS_PAGE_SIZE}.`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_ORDERS_PAGE_SIZE)
  limit: number = 20;

  @Field(() => Int, { defaultValue: 0, description: 'Number of orders to skip, ≥ 0.' })
  @IsInt()
  @Min(0)
  offset: number = 0;
}
