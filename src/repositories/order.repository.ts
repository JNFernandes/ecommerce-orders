import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order } from '../domain/order.aggregate';
import { OrderItem } from '../domain/order-item.value-object';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderEntity } from '../infra/database/entities/order.entity';
import { OrderItemEntity } from '../infra/database/entities/order-item.entity';
import {
  ProcessedEventEntity,
  ProcessedEventOutcome,
} from '../infra/database/entities/processed-event.entity';
import { InboundEventRef } from '../commands/inbound-event-ref';
import { EventAlreadyProcessedError } from '../services/errors/payment-outcome.errors';
import { OrderStatusChangedConcurrentlyError } from './errors/order-status-changed-concurrently.error';
import { isUniqueViolation } from './errors/is-unique-violation';

/** Persists the Order aggregate (and its consolidated items) to PostgreSQL. */
@Injectable()
export class OrderRepository {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async save(order: Order): Promise<void> {
    const entity = this.orderRepository.create({
      id: order.id,
      customerId: order.customerId,
      status: order.status,
      totalAmount: order.totalAmount.toFixed(2),
      items: order.items.map((item) => {
        const itemEntity = new OrderItemEntity();
        itemEntity.id = randomUUID();
        itemEntity.orderId = order.id;
        itemEntity.productId = item.productId;
        itemEntity.quantity = item.quantity;
        itemEntity.unitPrice = item.unitPrice.toFixed(2);
        itemEntity.subtotal = item.subtotal.toFixed(2);
        return itemEntity;
      }),
    });

    await this.orderRepository.save(entity);
  }

  /** Loads an existing order (with its items) and reconstitutes the domain aggregate. */
  async findById(id: string): Promise<Order | null> {
    const entity = await this.orderRepository.findOne({ where: { id } });
    if (!entity) {
      return null;
    }

    const items = entity.items.map((item) =>
      OrderItem.create(item.productId, item.quantity, Number(item.unitPrice)),
    );

    return Order.reconstitute(
      entity.id,
      entity.customerId,
      entity.status,
      items,
      Number(entity.totalAmount),
      entity.createdAt,
      entity.updatedAt,
      entity.cancellationReason,
    );
  }

  /** Persists a status transition (e.g. cancellation) without touching the order's items. */
  async updateStatus(id: string, status: OrderStatus, updatedAt: Date): Promise<void> {
    await this.orderRepository.update({ id }, { status, updatedAt });
  }

  /**
   * Persists a status transition triggered by a consumed event, atomically with the
   * `processed_events` record for that event. The update only applies while the order is still
   * PENDING, so a concurrent change (e.g. a REST cancel) is never overwritten.
   *
   * @throws OrderStatusChangedConcurrentlyError if the order was no longer PENDING (retryable).
   * @throws EventAlreadyProcessedError if the event's `eventId` is already recorded.
   */
  async applyInboundStatusChange(
    order: Order,
    inbound: InboundEventRef,
    outcome: ProcessedEventOutcome,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const result = await manager
          .createQueryBuilder()
          .update(OrderEntity)
          .set({
            status: order.status,
            updatedAt: order.updatedAt,
            cancellationReason: order.cancellationReason,
          })
          .where('id = :id AND status = :pending', {
            id: order.id,
            pending: OrderStatus.PENDING,
          })
          .execute();
        if (!result.affected) {
          throw new OrderStatusChangedConcurrentlyError(order.id);
        }

        await manager.insert(ProcessedEventEntity, {
          eventId: inbound.eventId,
          topic: inbound.topic,
          orderId: inbound.orderId,
          paymentId: inbound.paymentId,
          outcome,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EventAlreadyProcessedError(inbound.eventId);
      }
      throw error;
    }
  }
}
