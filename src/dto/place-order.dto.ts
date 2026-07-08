import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/** A single item within a place-order request. */
export class PlaceOrderItemDto {
  @ApiProperty({ example: 'prod-001', description: 'Reference to the product being ordered' })
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @ApiProperty({ example: 2, description: 'Number of units, must be a positive integer' })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ example: 29.99, description: 'Price per unit, must be greater than 0' })
  @IsNumber()
  @IsPositive()
  unitPrice!: number;
}

/** Request body for POST /orders. */
export class PlaceOrderDto {
  @ApiProperty({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description:
      'Identifier of the customer placing the order; must reference an existing customer',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ type: [PlaceOrderItemDto], description: 'One or more items in the order' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PlaceOrderItemDto)
  items!: PlaceOrderItemDto[];
}
