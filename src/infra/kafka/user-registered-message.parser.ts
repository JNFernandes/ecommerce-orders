import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import { UserRegisteredMessageDto } from '../../dto/user-registered-message.dto';
import { MalformedMessageError } from './malformed-message.error';

/** A user registered in ecommerce-identity; Orders creates the matching customer (US-10). */
export const USER_REGISTERED_TOPIC = 'identity.user-registered';

/** A validated user-registered message, reduced to what the Orders service acts on. */
export interface ParsedUserRegisteredMessage {
  /** The consumed event's `eventId` (dedupe key). */
  eventId: string;
  /** The payload's `customerId`; its `aggregateId` (the user id) is never returned. */
  customerId: string;
  /** Display name, or null when the payload has none. */
  name: string | null;
  /** Email address, as received. */
  email: string;
}

/**
 * Parses and validates a raw `identity.user-registered` message. The customer is identified by
 * the payload's `customerId`; its `aggregateId` (the user id) is never used.
 *
 * @throws MalformedMessageError (with the `eventId` when it can be read) if the value is not a
 *   JSON object, the topic is not `identity.user-registered`, or the payload fails the DTO rules.
 */
export function parseUserRegisteredMessage(
  topic: string,
  rawValue: Buffer | null,
): ParsedUserRegisteredMessage {
  if (rawValue === null) {
    throw new MalformedMessageError('message value is empty');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawValue.toString('utf8'));
  } catch {
    throw new MalformedMessageError('message value is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new MalformedMessageError('message value is not a JSON object');
  }

  const fields = body as Record<string, unknown>;
  const rawEventId = fields.eventId;
  const eventId = typeof rawEventId === 'string' && isUUID(rawEventId) ? rawEventId : undefined;

  if (topic !== USER_REGISTERED_TOPIC) {
    throw new MalformedMessageError(`unsupported topic ${topic}`, eventId);
  }

  const dto = plainToInstance(UserRegisteredMessageDto, fields);
  const errors = validateSync(dto);
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new MalformedMessageError(`invalid ${topic} message: ${details}`, eventId);
  }

  return {
    eventId: dto.eventId,
    customerId: dto.customerId,
    name: dto.name ?? null,
    email: dto.email,
  };
}
