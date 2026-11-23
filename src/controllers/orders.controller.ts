import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
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
import { OrderRequester } from '../domain/order-requester';
import { AccessTokenClaims, effectiveRoles } from '../infra/auth/access-token-claims';
import { Role } from '../infra/auth/role.enum';
import { CurrentUser } from './auth/current-user.decorator';
import { Roles } from './auth/roles.decorator';

/** Builds the domain's view of the caller from its effective roles (research R10, R12). */
function toOrderRequester(user: AccessTokenClaims): OrderRequester {
  const roles = effectiveRoles(user);
  return {
    customerId: roles.includes(Role.CUSTOMER) ? (user.customerId ?? null) : null,
    isAdmin: roles.includes(Role.ADMIN),
  };
}

/**
 * REST entry point for the Orders write path. Every route needs an Identity access token
 * (US-11); each states its roles with `@Roles`, the global guards enforce them.
 */
@ApiTags('orders')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({
  description: 'Missing or invalid access token (header `WWW-Authenticate: Bearer`)',
  schema: { example: { statusCode: 401, message: 'Unauthorized' } },
})
@ApiForbiddenResponse({
  description: 'Valid token without a role allowed on this operation',
  schema: { example: { statusCode: 403, message: 'Forbidden', error: 'Forbidden' } },
})
@ApiServiceUnavailableResponse({
  description: "Identity's signing keys cannot be loaded; retry later",
  schema: { example: { statusCode: 503, message: 'Service Unavailable' } },
})
@Controller('orders')
export class OrdersController {
  constructor(private readonly commandBus: CommandBus) {}

  /** Places an order for the calling customer; the customer id comes from the token only. */
  @Post()
  @HttpCode(201)
  @Roles(Role.CUSTOMER)
  @ApiOperation({
    summary: 'Place an order',
    description:
      'Roles: `CUSTOMER`. The order is placed for the caller: the customer is the access ' +
      "token's `customerId`. The body holds only `items`; a `customerId` in it is rejected (400).",
  })
  @ApiCreatedResponse({ type: PlaceOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  async placeOrder(
    @Body() dto: PlaceOrderDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<PlaceOrderResponseDto> {
    // Unreachable after RolesGuard (CUSTOMER counts only with a customerId); narrows the type.
    if (user.customerId === undefined) {
      throw new ForbiddenException();
    }
    try {
      const result: PlaceOrderResult = await this.commandBus.execute(
        new PlaceOrderCommand(user.customerId, dto.items),
      );
      return { orderId: result.orderId };
    } catch (error) {
      if (error instanceof OrderValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Cancels a pending order; customers may cancel only their own orders. */
  @Post(':orderId/cancel')
  @HttpCode(200)
  @Roles(Role.CUSTOMER, Role.ADMIN)
  @ApiOperation({
    summary: 'Cancel a pending order',
    description:
      "Roles: `CUSTOMER` (own orders) or `ADMIN` (any order). Another customer's order " +
      'answers 404, exactly like an unknown id.',
  })
  @ApiOkResponse({ type: CancelOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order is not in a cancellable (PENDING) state' })
  async cancelOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CancelOrderResponseDto> {
    try {
      const result: CancelOrderResult = await this.commandBus.execute(
        new CancelOrderCommand(orderId, toOrderRequester(user)),
      );
      return { orderId: result.orderId, status: result.status };
    } catch (error) {
      if (error instanceof OrderCancellationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /** Confirms a pending order by hand: an operator override, for administrators only. */
  @Post(':orderId/confirm')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Confirm a pending order (e.g. after payment is processed)',
    description:
      'Roles: `ADMIN`. Operator override: orders confirm on their own once payment is ' +
      'processed and stock is reserved.',
  })
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
