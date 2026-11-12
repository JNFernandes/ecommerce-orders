/** Retry state of a dead-letter row (outbound or inbound). */
export enum DeadLetterStatus {
  /** Waiting for the retry worker; claimed once `nextRetryAt` is due. */
  PENDING_RETRY = 'PENDING_RETRY',
  /** A retry succeeded. Final: never claimed again. */
  RESOLVED = 'RESOLVED',
  /** Can never succeed (malformed) or ran out of retries. Final: never claimed again. */
  EXHAUSTED = 'EXHAUSTED',
}
