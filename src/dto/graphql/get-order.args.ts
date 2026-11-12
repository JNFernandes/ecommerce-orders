import { ArgsType, Field, ID } from '@nestjs/graphql';
import { IsUUID } from 'class-validator';

/** Arguments of the `order` query, validated by the global ValidationPipe. */
@ArgsType()
export class GetOrderArgs {
  @Field(() => ID, { description: 'Order identifier (UUID, any case).' })
  @IsUUID()
  orderId!: string;
}
