import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order } from '../domain/order.aggregate';
import { OrderItem } from '../domain/order-item.value-object';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderEntity } from '../infra/database/entities/order.entity';
import { OrderItemEntity } from '../infra/database/entities/order-item.entity';

/** Persists the Order aggregate (and its consolidated items) to PostgreSQL. */
@Injectable()
export class OrderRepository {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
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
    );
  }

  /** Persists a status transition (e.g. cancellation) without touching the order's items. */
  async updateStatus(id: string, status: OrderStatus, updatedAt: Date): Promise<void> {
    await this.orderRepository.update({ id }, { status, updatedAt });
  }
}
