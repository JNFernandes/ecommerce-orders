/**
 * The view was changed by another writer between read and write (insert race or stale
 * revision). Retryable: on retry the view is re-read and the event re-projected.
 */
export class OrderViewConcurrencyError extends Error {
  constructor(public readonly orderId: string) {
    super(`order view ${orderId} was modified concurrently`);
    this.name = 'OrderViewConcurrencyError';
  }
}

/**
 * The read-model store (MongoDB) is unreachable. The event is not at fault, so it is never
 * dead-lettered: once retries run out the offset stays uncommitted and it is redelivered.
 */
export class ReadModelUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super(`read model unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ReadModelUnavailableError';
  }
}
