import { ApiProperty } from '@nestjs/swagger';

/** Response body for a successfully placed order. */
export class PlaceOrderResponseDto {
  @ApiProperty({ example: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  orderId!: string;
}
