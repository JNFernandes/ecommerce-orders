import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CustomerRepository } from '../repositories/customer.repository';
import { Order } from '../domain/order.aggregate';
import { OrderPlaced } from '../domain/events/order-placed.event';
import { OrderRepository } from '../repositories/order.repository';
import { OrderDeadLetterRepository } from '../repositories/order-dead-letter.repository';
import { ORDER_PLACED_TOPIC, OrderEventsProducer } from '../infra/kafka/order-events.producer';
import { PlaceOrderCommand } from '../commands/place-order.command';

export interface PlaceOrderResult {
  orderId: string;
}

/**
 * Application-layer service that orchestrates placing an order: verifies the customer
 * exists, delegates business rules to Order.place(), saves to PostgreSQL, and — only
 * after that save succeeds — publishes OrderPlaced to Kafka. A Kafka publish failure is
 * captured to the dead-letter table and never turns into a client-visible error, since
 * the order was already durably saved.
 *
 * Registered as the CQRS command handler for PlaceOrderCommand — the @CommandHandler
 * decorator is what wires it into NestJS's command bus, independent of the class name.
 */
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderService implements ICommandHandler<PlaceOrderCommand, PlaceOrderResult> {
  private readonly logger = new Logger(PlaceOrderService.name);

  constructor(
    private readonly customerRepository: CustomerRepository,
    private readonly orderRepository: OrderRepository,
    private readonly orderEventsProducer: OrderEventsProducer,
    private readonly orderDeadLetterRepository: OrderDeadLetterRepository,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const customerExists = await this.customerRepository.existsById(command.customerId);
    if (!customerExists) {
      throw new NotFoundException('Customer not found');
    }

    const order = Order.place(command.customerId, command.items);
    const [orderPlacedEvent] = order.pullDomainEvents() as [OrderPlaced];

    await this.orderRepository.save(order);

    try {
      await this.orderEventsProducer.publishOrderPlaced(orderPlacedEvent);
    } catch (error) {
      this.logger.error(
        `Failed to publish OrderPlaced for order ${order.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.orderDeadLetterRepository.recordFailure(
        ORDER_PLACED_TOPIC,
        orderPlacedEvent,
        error as Error,
      );
    }

    return { orderId: order.id };
  }
}
