import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ApiCreatedResponse, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlaceOrderCommand } from '../commands/place-order.command';
import { PlaceOrderResult } from '../services/place-order.service';
import { OrderValidationError } from '../domain/order-validation.error';
import { PlaceOrderDto } from '../dto/place-order.dto';
import { PlaceOrderResponseDto } from '../dto/place-order-response.dto';

/** REST entry point for the Orders write path. */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Place an order' })
  @ApiCreatedResponse({ type: PlaceOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  async placeOrder(@Body() dto: PlaceOrderDto): Promise<PlaceOrderResponseDto> {
    try {
      const result: PlaceOrderResult = await this.commandBus.execute(
        new PlaceOrderCommand(dto.customerId, dto.items),
      );
      return { orderId: result.orderId };
    } catch (error) {
      if (error instanceof OrderValidationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof HttpException) {
        throw error;
      }
      throw error;
    }
  }
}
