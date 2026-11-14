import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { StockOutcome } from '../../domain/stock-outcome.enum';
import { InboundEventRef } from '../../commands/inbound-event-ref';
import { StockReservedMessageDto } from '../../dto/stock-reserved-message.dto';
import { StockRejectedMessageDto } from '../../dto/stock-rejected-message.dto';
import { MalformedMessageError } from './malformed-message.error';

/** Every item of the order was reserved (published by ecommerce-inventory). */
export const STOCK_RESERVED_TOPIC = 'inventory.stock-reserved';
/** At least one item could not be reserved, so nothing was (published by ecommerce-inventory). */
export const STOCK_REJECTED_TOPIC = 'inventory.stock-rejected';

/**
 * A consumed stock message that can never be processed (not JSON, missing or invalid required
 * fields, unsupported version or topic). Not retryable: it is dead-lettered immediately.
 */
export class MalformedStockMessageError extends MalformedMessageError {
  constructor(message: string, eventId?: string, orderId?: string) {
    super(message, eventId, orderId);
    this.name = 'MalformedStockMessageError';
  }
}

/** A validated stock message, reduced to what the Orders service acts on. */
export interface ParsedStockMessage {
  outcome: StockOutcome.RESERVED | StockOutcome.REJECTED;
  /** `orderId` from the payload; the payload's `aggregateId` is only the `reservationId`. */
  inboundEvent: InboundEventRef;
  /** Rejection reason (stock-rejected only), when the message carries one. */
  reason?: string;
}

function readUuid(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && isUUID(value) ? value : undefined;
}

/**
 * Parses and validates a raw stock message from `topic`. The order is identified by the
 * payload's `orderId`; its `aggregateId` (the reservation id) is never used as an order id.
 *
 * @throws MalformedStockMessageError if the value is not a JSON object, the topic is not a
 *   stock topic, or the payload fails the DTO rules.
 */
export function parseStockMessage(topic: string, rawValue: Buffer | null): ParsedStockMessage {
  if (rawValue === null) {
    throw new MalformedStockMessageError('message value is empty');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawValue.toString('utf8'));
  } catch {
    throw new MalformedStockMessageError('message value is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedStockMessageError('message value is not a JSON object');
  }

  const fields = body as Record<string, unknown>;
  const eventId = readUuid(fields, 'eventId');
  const orderId = readUuid(fields, 'orderId');

  let dto: StockReservedMessageDto | StockRejectedMessageDto;
  let outcome: StockOutcome.RESERVED | StockOutcome.REJECTED;
  if (topic === STOCK_RESERVED_TOPIC) {
    dto = plainToInstance(StockReservedMessageDto, fields);
    outcome = StockOutcome.RESERVED;
  } else if (topic === STOCK_REJECTED_TOPIC) {
    dto = plainToInstance(StockRejectedMessageDto, fields);
    outcome = StockOutcome.REJECTED;
  } else {
    throw new MalformedStockMessageError(`unsupported topic ${topic}`, eventId, orderId);
  }

  const errors = validateSync(dto);
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new MalformedStockMessageError(`invalid ${topic} message: ${details}`, eventId, orderId);
  }

  const inboundEvent: InboundEventRef = {
    eventId: dto.eventId,
    topic,
    orderId: dto.orderId,
    reservationId: dto.aggregateId,
  };

  if (dto instanceof StockRejectedMessageDto && typeof dto.reason === 'string') {
    return { outcome, inboundEvent, reason: dto.reason };
  }
  return { outcome, inboundEvent };
}
