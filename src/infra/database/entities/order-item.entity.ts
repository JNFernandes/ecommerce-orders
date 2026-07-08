import { Column, Entity, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { OrderEntity } from './order.entity';

/** Write-side persistence row for a single OrderItem line within an Order. */
@Entity('order_items')
@Unique(['orderId', 'productId'])
export class OrderItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: 'CASCADE' })
  order!: OrderEntity;

  @Column({ type: 'varchar' })
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  unitPrice!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal!: string;
}
