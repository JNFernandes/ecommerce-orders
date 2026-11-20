import { Equals, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * Inbound `identity.user-registered` message (published by ecommerce-identity, contract in
 * ecommerce-infra/docs/events.md). Only the fields Orders uses are validated; unknown fields are
 * accepted and ignored. See specs/008-customers-from-identity/contracts/user-registered.md.
 */
export class UserRegisteredMessageDto {
  /** Unique id of this event instance (dedupe key). */
  @IsUUID()
  eventId!: string;

  /** The user id. NOT a customer id: never stored or used. */
  @IsUUID()
  aggregateId!: string;

  /** When the event was raised (not used). */
  @IsString()
  occurredAt!: string;

  /** Schema version; only `1` is supported. */
  @Equals(1)
  version!: number;

  /** The customer to create: becomes the customer id. */
  @IsUUID()
  customerId!: string;

  /** The customer's email address; must contain a non-blank character. */
  @IsString()
  @Matches(/\S/, { message: 'email must not be empty' })
  email!: string;

  /** The customer's display name, when known. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
