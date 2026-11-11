import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { OrderViewStatus } from './order-view-status.enum';

/** Embedded order line (no own `_id`). */
@Schema({ _id: false, versionKey: false })
export class OrderItemViewDocument {
  @Prop({ type: String, required: true })
  productId!: string;

  @Prop({ type: Number, required: true })
  quantity!: number;

  @Prop({ type: Number, required: true })
  unitPrice!: number;

  @Prop({ type: Number, required: true })
  subtotal!: number;
}

export const OrderItemViewSchema = SchemaFactory.createForClass(OrderItemViewDocument);

/**
 * MongoDB document for one order in `order_views`. Mongoose's automatic `__v` and timestamps
 * are disabled: the document must be a deterministic function of the applied events.
 */
@Schema({ collection: 'order_views', versionKey: false, timestamps: false })
export class OrderViewDocument {
  /** The order id. */
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: String, required: true })
  orderId!: string;

  @Prop({ type: String, required: true })
  customerId!: string;

  @Prop({ type: String, enum: Object.values(OrderViewStatus), required: true })
  status!: OrderViewStatus;

  @Prop({ type: [OrderItemViewSchema], default: null })
  items!: OrderItemViewDocument[] | null;

  @Prop({ type: Number, default: null })
  totalAmount!: number | null;

  @Prop({ type: Date, default: null })
  placedAt!: Date | null;

  @Prop({ type: Date, default: null })
  confirmedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: String, default: null })
  cancellationReason!: string | null;

  @Prop({ type: Date, required: true })
  updatedAt!: Date;

  @Prop({ type: [String], required: true })
  appliedEventIds!: string[];

  @Prop({ type: String, default: null })
  statusEventId!: string | null;

  /** Optimistic-concurrency revision (equals the number of applied events). */
  @Prop({ type: Number, required: true })
  revision!: number;
}

export const OrderViewSchema = SchemaFactory.createForClass(OrderViewDocument);
