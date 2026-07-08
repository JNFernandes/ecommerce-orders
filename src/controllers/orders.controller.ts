import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlaceOrderCommand } from '../commands/place-order.command';
import { PlaceOrderResult } from '../services/place-order.service';
import { CancelOrderCommand } from '../commands/cancel-order.command';
import { CancelOrderResult } from '../services/cancel-order.service';
import { ConfirmOrderCommand } from '../commands/confirm-order.command';
import { ConfirmOrderResult } from '../services/confirm-order.service';
import { OrderValidationError } from '../domain/order-validation.error';
import { OrderCancellationError } from '../domain/order-cancellation.error';
import { OrderConfirmationError } from '../domain/order-confirmation.error';
import { PlaceOrderDto } from '../dto/place-order.dto';
import { PlaceOrderResponseDto } from '../dto/place-order-response.dto';
import { CancelOrderResponseDto } from '../dto/cancel-order-response.dto';
import { ConfirmOrderResponseDto } from '../dto/confirm-order-response.dto';

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
      throw error;
    }
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a pending order' })
  @ApiOkResponse({ type: CancelOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order is not in a cancellable (PENDING) state' })
  async cancelOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<CancelOrderResponseDto> {
    try {
      const result: CancelOrderResult = await this.commandBus.execute(
        new CancelOrderCommand(orderId),
      );
      return { orderId: result.orderId, status: result.status };
    } catch (error) {
      if (error instanceof OrderCancellationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post(':orderId/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm a pending order (e.g. after payment is processed)' })
  @ApiOkResponse({ type: ConfirmOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order is not in a confirmable (PENDING) state' })
  async confirmOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ConfirmOrderResponseDto> {
    try {
      const result: ConfirmOrderResult = await this.commandBus.execute(
        new ConfirmOrderCommand(orderId),
      );
      return { orderId: result.orderId, status: result.status };
    } catch (error) {
      if (error instanceof OrderConfirmationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
