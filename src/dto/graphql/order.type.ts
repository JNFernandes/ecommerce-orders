import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { OrderView } from '../../read-model/order-view';
import { OrderViewStatus } from '../../read-model/order-view-status.enum';
import { OrderItemType } from './order-item.type';
import './order-status.enum';

/**
 * GraphQL `Order`: an order as seen by the read model. Built from OrderView only — never from the
 * write-model entities or the domain aggregate — and without the read model's internal
 * bookkeeping (applied event ids, revision, deciding event, updatedAt).
 */
@ObjectType('Order', {
  description: 'An order as seen by the read model (eventually consistent with the write side).',
})
export class OrderType {
  @Field(() => ID, { description: 'Order identifier (UUID).' })
  orderId!: string;

  @Field(() => ID, { description: 'Customer who placed the order (UUID).' })
  customerId!: string;

  @Field(() => OrderViewStatus, { description: 'Current lifecycle status.' })
  status!: OrderViewStatus;

  @Field(() => [OrderItemType], {
    nullable: true,
    description: 'Line items; null until the order-placed event has been projected.',
  })
  items!: OrderItemType[] | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Order total; null until the order-placed event has been projected.',
  })
  totalAmount!: number | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the order was placed; null until the order-placed event has been projected.',
  })
  placedAt!: Date | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the order was confirmed; null unless status is CONFIRMED.',
  })
  confirmedAt!: Date | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the order was cancelled; null unless status is CANCELLED.',
  })
  cancelledAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why the order was cancelled (e.g. the payment failure reason); null when none was given.',
  })
  cancellationReason!: string | null;

  /** Maps a read-model view to the GraphQL type, copying only the exposed fields. */
  static fromView(view: OrderView): OrderType {
    const order = new OrderType();
    order.orderId = view.orderId;
    order.customerId = view.customerId;
    order.status = view.status;
    order.items =
      view.items?.map((item) => {
        const line = new OrderItemType();
        line.productId = item.productId;
        line.quantity = item.quantity;
        line.unitPrice = item.unitPrice;
        line.subtotal = item.subtotal;
        return line;
      }) ?? null;
    order.totalAmount = view.totalAmount;
    order.placedAt = view.placedAt;
    order.confirmedAt = view.confirmedAt;
    order.cancelledAt = view.cancelledAt;
    order.cancellationReason = view.cancellationReason;
    return order;
  }
}
