import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order } from '../domain/order.aggregate';
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
}
