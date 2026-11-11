import { registerEnumType } from '@nestjs/graphql';
import { OrderViewStatus } from '../../read-model/order-view-status.enum';

/**
 * Exposes the read model's OrderViewStatus as the GraphQL enum `OrderStatus`. The read-side enum is
 * used (not the write-side OrderStatus) so the GraphQL read path never imports write-model types.
 */
registerEnumType(OrderViewStatus, {
  name: 'OrderStatus',
  description: 'Lifecycle status of an order.',
  valuesMap: {
    PENDING: { description: 'Placed, waiting for the payment outcome.' },
    CONFIRMED: { description: 'Payment succeeded; the order is confirmed.' },
    CANCELLED: {
      description: 'Cancelled — the payment failed or the order was cancelled through the API.',
    },
  },
});
