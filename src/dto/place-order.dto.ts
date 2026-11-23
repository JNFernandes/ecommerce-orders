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

/**
 * Request body for POST /orders. Holds only the items: the customer is the caller, taken from the
 * access token's `customerId` (US-11). A body with any other property, `customerId` included, is
 * rejected with 400 by the global `ValidationPipe` (`forbidNonWhitelisted`).
 */
export class PlaceOrderDto {
  @ApiProperty({ type: [PlaceOrderItemDto], description: 'One or more items in the order' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PlaceOrderItemDto)
  items!: PlaceOrderItemDto[];
}
