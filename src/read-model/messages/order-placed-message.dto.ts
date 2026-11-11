// @Type() (nested validation) reads design-time metadata; load the polyfill here so the DTO also
// works outside a Nest application (e.g. in pure unit tests).
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  Equals,
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/** One line of an `orders.order-placed` message. */
export class OrderPlacedItemMessageDto {
  /** Product identifier. */
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /** Units ordered (positive integer). */
  @IsInt()
  @Min(1)
  quantity!: number;

  /** Price per unit (non-negative). */
  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

/**
 * Inbound `orders.order-placed` message as consumed by the read-model projection.
 * Read-side DTO: deliberately separate from the write-side OrderPlaced domain event class,
 * even though the JSON shape is the same (Constitution Principle II). See
 * docs/events/order-placed.md.
 */
export class OrderPlacedMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** When the order was placed. */
  @IsISO8601()
  occurredAt!: string;

  /** The order id. */
  @IsUUID()
  aggregateId!: string;

  /** Schema version; only `1` is supported. */
  @Equals(1)
  version!: number;

  /** The customer who placed the order. */
  @IsUUID()
  customerId!: string;

  /** Consolidated line items (at least one). */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderPlacedItemMessageDto)
  items!: OrderPlacedItemMessageDto[];

  /** Order total. */
  @IsNumber()
  @Min(0)
  totalAmount!: number;
}
