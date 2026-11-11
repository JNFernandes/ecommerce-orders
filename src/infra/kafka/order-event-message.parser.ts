import { ClassConstructor, plainToInstance } from 'class-transformer';
import { ValidationError, isUUID, validateSync } from 'class-validator';
import { OrderEvent } from '../../read-model/order-event';
import { OrderPlacedMessageDto } from '../../read-model/messages/order-placed-message.dto';
import { OrderConfirmedMessageDto } from '../../read-model/messages/order-confirmed-message.dto';
import { OrderCancelledMessageDto } from '../../read-model/messages/order-cancelled-message.dto';
import { MalformedMessageError } from './malformed-message.error';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
} from './order-events.producer';

/** Topics the read-model projection consumes. */
export const ORDER_EVENT_TOPICS: readonly string[] = [
  ORDER_PLACED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_CANCELLED_TOPIC,
];

function readUuid(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && isUUID(value) ? value : undefined;
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}${error.property}`;
    const own = Object.values(error.constraints ?? {}).map((c) => `${path}: ${c}`);
    return [...own, ...flatten(error.children ?? [], `${path}.`)];
  });
}

/**
 * Parses and validates a raw order event from `topic` into an OrderEvent.
 *
 * @throws MalformedMessageError when the value is not a JSON object, the topic is unknown, or
 *   the payload fails the DTO rules (carrying any `eventId` / `aggregateId` it could read).
 */
export function parseOrderEventMessage(topic: string, value: Buffer | null): OrderEvent {
  if (value === null) {
    throw new MalformedMessageError('message value is empty');
  }

  let body: unknown;
  try {
    body = JSON.parse(value.toString('utf8'));
  } catch {
    throw new MalformedMessageError('message value is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedMessageError('message value is not a JSON object');
  }

  const fields = body as Record<string, unknown>;
  const eventId = readUuid(fields, 'eventId');
  const orderId = readUuid(fields, 'aggregateId');

  function validated<D extends object>(dtoClass: ClassConstructor<D>): D {
    const dto = plainToInstance(dtoClass, fields);
    const errors = validateSync(dto);
    if (errors.length > 0) {
      throw new MalformedMessageError(
        `invalid ${topic} message: ${flatten(errors).join('; ')}`,
        eventId,
        orderId,
      );
    }
    return dto;
  }

  switch (topic) {
    case ORDER_PLACED_TOPIC: {
      const dto = validated(OrderPlacedMessageDto);
      return {
        type: 'OrderPlaced',
        eventId: dto.eventId,
        orderId: dto.aggregateId,
        occurredAt: new Date(dto.occurredAt),
        customerId: dto.customerId,
        items: dto.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        totalAmount: dto.totalAmount,
      };
    }
    case ORDER_CONFIRMED_TOPIC: {
      const dto = validated(OrderConfirmedMessageDto);
      return {
        type: 'OrderConfirmed',
        eventId: dto.eventId,
        orderId: dto.aggregateId,
        occurredAt: new Date(dto.occurredAt),
        customerId: dto.customerId,
      };
    }
    case ORDER_CANCELLED_TOPIC: {
      const dto = validated(OrderCancelledMessageDto);
      return {
        type: 'OrderCancelled',
        eventId: dto.eventId,
        orderId: dto.aggregateId,
        occurredAt: new Date(dto.occurredAt),
        customerId: dto.customerId,
        reason: dto.reason ?? null,
      };
    }
    default:
      throw new MalformedMessageError(`unsupported topic ${topic}`, eventId, orderId);
  }
}
