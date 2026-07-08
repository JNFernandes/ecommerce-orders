import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderConfirmed } from '../domain/events/order-confirmed.event';
import { OrderRepository } from '../repositories/order.repository';
import { OrderDeadLetterRepository } from '../repositories/order-dead-letter.repository';
import { ORDER_CONFIRMED_TOPIC, OrderEventsProducer } from '../infra/kafka/order-events.producer';
import { ConfirmOrderCommand } from '../commands/confirm-order.command';

export interface ConfirmOrderResult {
  orderId: string;
  status: OrderStatus;
}

/**
 * Application-layer service that orchestrates confirming an order (e.g. after payment has
 * been processed): loads it, delegates the PENDING-only business rule to Order.confirm(),
 * persists the status change, and — only after that save succeeds — publishes
 * OrderConfirmed to Kafka. A Kafka publish failure is captured to the dead-letter table
 * and never turns into a client-visible error, since the confirmation itself already
 * succeeded.
 */
@CommandHandler(ConfirmOrderCommand)
export class ConfirmOrderService implements ICommandHandler<
  ConfirmOrderCommand,
  ConfirmOrderResult
> {
  private readonly logger = new Logger(ConfirmOrderService.name);

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly orderEventsProducer: OrderEventsProducer,
    private readonly orderDeadLetterRepository: OrderDeadLetterRepository,
  ) {}

  async execute(command: ConfirmOrderCommand): Promise<ConfirmOrderResult> {
    const order = await this.orderRepository.findById(command.orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    order.confirm();
    const [orderConfirmedEvent] = order.pullDomainEvents() as [OrderConfirmed];

    await this.orderRepository.updateStatus(order.id, order.status, order.updatedAt);

    try {
      await this.orderEventsProducer.publishOrderConfirmed(orderConfirmedEvent);
    } catch (error) {
      this.logger.error(
        `Failed to publish OrderConfirmed for order ${order.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.orderDeadLetterRepository.recordFailure(
        ORDER_CONFIRMED_TOPIC,
        orderConfirmedEvent,
        error as Error,
      );
    }

    return { orderId: order.id, status: order.status };
  }
}
