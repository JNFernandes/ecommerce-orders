import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { PaymentOutcome } from '../../domain/payment-outcome.enum';
import { InboundEventRef } from '../../commands/inbound-event-ref';
import { PaymentProcessedMessageDto } from '../../dto/payment-processed-message.dto';
import { PaymentFailedMessageDto } from '../../dto/payment-failed-message.dto';
import { MalformedMessageError } from './malformed-message.error';

export const PAYMENT_PROCESSED_TOPIC = 'payments.payment-processed';
export const PAYMENT_FAILED_TOPIC = 'payments.payment-failed';

/**
 * A consumed payment message that can never be processed (not JSON, missing or invalid
 * required fields, unsupported version). Not retryable: it is dead-lettered immediately.
 */
export class MalformedPaymentMessageError extends MalformedMessageError {
  constructor(message: string, eventId?: string, orderId?: string) {
    super(message, eventId, orderId);
    this.name = 'MalformedPaymentMessageError';
  }
}

/** A validated payment message, reduced to what the Orders service acts on. */
export interface ParsedPaymentMessage {
  outcome: PaymentOutcome;
  inboundEvent: InboundEventRef;
  /** Failure reason (payment-failed only), normalised to '' when absent. */
  reason?: string;
}

function readUuid(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && isUUID(value) ? value : undefined;
}

/**
 * Parses and validates a raw payment message from `topic`.
 *
 * @throws MalformedPaymentMessageError if the value is not a JSON object, or fails the DTO rules.
 */
export function parsePaymentMessage(topic: string, rawValue: Buffer | null): ParsedPaymentMessage {
  if (rawValue === null) {
    throw new MalformedPaymentMessageError('message value is empty');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawValue.toString('utf8'));
  } catch {
    throw new MalformedPaymentMessageError('message value is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedPaymentMessageError('message value is not a JSON object');
  }

  const fields = body as Record<string, unknown>;
  const eventId = readUuid(fields, 'eventId');
  const orderId = readUuid(fields, 'orderId');

  let dto: PaymentProcessedMessageDto | PaymentFailedMessageDto;
  let outcome: PaymentOutcome;
  if (topic === PAYMENT_PROCESSED_TOPIC) {
    dto = plainToInstance(PaymentProcessedMessageDto, fields);
    outcome = PaymentOutcome.PROCESSED;
  } else if (topic === PAYMENT_FAILED_TOPIC) {
    dto = plainToInstance(PaymentFailedMessageDto, fields);
    outcome = PaymentOutcome.FAILED;
  } else {
    throw new MalformedPaymentMessageError(`unsupported topic ${topic}`, eventId, orderId);
  }

  const errors = validateSync(dto);
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new MalformedPaymentMessageError(
      `invalid ${topic} message: ${details}`,
      eventId,
      orderId,
    );
  }

  const inboundEvent: InboundEventRef = {
    eventId: dto.eventId,
    topic,
    orderId: dto.orderId,
    paymentId: dto.aggregateId,
  };

  if (dto instanceof PaymentFailedMessageDto) {
    return { outcome, inboundEvent, reason: dto.reason ?? '' };
  }
  return { outcome, inboundEvent };
}
