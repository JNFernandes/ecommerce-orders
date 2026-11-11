/**
 * The order was no longer PENDING when the conditional status update ran (another change won
 * the race). Retryable: on retry the payment reaction is re-decided against the fresh status.
 */
export class OrderStatusChangedConcurrentlyError extends Error {
  constructor(public readonly orderId: string) {
    super(`order ${orderId} is no longer PENDING; its status changed concurrently`);
    this.name = 'OrderStatusChangedConcurrentlyError';
  }
}
