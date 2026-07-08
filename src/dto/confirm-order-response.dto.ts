import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../domain/order-status.enum';

/** Response body for a successfully confirmed order. */
export class ConfirmOrderResponseDto {
  @ApiProperty({ example: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  orderId!: string;

  @ApiProperty({ enum: OrderStatus, example: OrderStatus.CONFIRMED })
  status!: OrderStatus;
}
