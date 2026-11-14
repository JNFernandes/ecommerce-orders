import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderRepository } from '../repositories/order.repository';
import { OrderDeadLetterRepository } from '../repositories/order-dead-letter.repository';
import { ORDER_CANCELLED_TOPIC, OrderEventsProducer } from '../infra/kafka/order-events.producer';
import { CancelOrderCommand } from '../commands/cancel-order.command';

export interface CancelOrderResult {
  orderId: string;
  status: OrderStatus;
}

/**
 * Application-layer service that orchestrates cancelling an order: loads it, delegates
 * the PENDING-only business rule to Order.cancel(), persists the status change, and —
 * only after that save succeeds — publishes OrderCancelled to Kafka. A Kafka publish
 * failure is captured to the dead-letter table and never turns into a client-visible
 * error, since the cancellation itself already succeeded.
 */
@CommandHandler(CancelOrderCommand)
export class CancelOrderService implements ICommandHandler<CancelOrderCommand, CancelOrderResult> {
  private readonly logger = new Logger(CancelOrderService.name);

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly orderEventsProducer: OrderEventsProducer,
    private readonly orderDeadLetterRepository: OrderDeadLetterRepository,
  ) {}

  async execute(command: CancelOrderCommand): Promise<CancelOrderResult> {
    const order = await this.orderRepository.findById(command.orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    order.cancel();
    const [orderCancelledEvent] = order.pullDomainEvents() as [OrderCancelled];

    await this.orderRepository.updateStatus(order.id, order.status, order.updatedAt);

    try {
      await this.orderEventsProducer.publishOrderCancelled(orderCancelledEvent);
    } catch (error) {
      this.logger.error(
        `Failed to publish OrderCancelled for order ${order.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.orderDeadLetterRepository.recordFailure(
        ORDER_CANCELLED_TOPIC,
        orderCancelledEvent,
        error as Error,
      );
    }

    return { orderId: order.id, status: order.status };
  }
}
