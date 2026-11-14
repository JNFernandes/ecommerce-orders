import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderStatus } from '../../../domain/order-status.enum';
import { PaymentOutcome } from '../../../domain/payment-outcome.enum';
import { StockOutcome } from '../../../domain/stock-outcome.enum';
import { OrderItemEntity } from './order-item.entity';

/** Write-side persistence row for the Order aggregate root. */
@Entity('orders')
export class OrderEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  totalAmount!: string;

  /**
   * Why the order was cancelled (set only for outcome-driven cancellations: `payment failed: …`
   * or `stock rejected: …`), otherwise null.
   */
  @Column({ type: 'text', nullable: true })
  cancellationReason!: string | null;

  /** Payment outcome received so far (US-09). */
  @Column({
    type: 'enum',
    enum: PaymentOutcome,
    enumName: 'order_payment_outcome_enum',
    default: PaymentOutcome.PENDING,
  })
  paymentOutcome!: PaymentOutcome;

  /** Stock outcome received so far (US-09). */
  @Column({
    type: 'enum',
    enum: StockOutcome,
    enumName: 'order_stock_outcome_enum',
    default: StockOutcome.PENDING,
  })
  stockOutcome!: StockOutcome;

  @OneToMany(() => OrderItemEntity, (item) => item.order, {
    cascade: true,
    eager: true,
  })
  items!: OrderItemEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
