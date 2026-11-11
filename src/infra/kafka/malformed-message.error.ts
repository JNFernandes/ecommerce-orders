/**
 * A consumed Kafka message that can never be processed (not JSON, missing or invalid required
 * fields, unsupported version). Not retryable: consumers dead-letter it immediately.
 */
export class MalformedMessageError extends Error {
  constructor(
    message: string,
    /** The message's `eventId`, if it could be read as a UUID. */
    public readonly eventId?: string,
    /** The order the message refers to, if it could be read as a UUID. */
    public readonly orderId?: string,
  ) {
    super(message);
    this.name = 'MalformedMessageError';
  }
}
