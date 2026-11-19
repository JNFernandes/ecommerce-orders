/** Longest accepted customer name, matching `customers.name` (varchar 100). */
export const CUSTOMER_NAME_MAX_LENGTH = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised by Customer.register() when the registration data violates a domain invariant. */
export class CustomerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerValidationError';
  }
}

/** Data of a user registration, as received from identity.user-registered. */
export interface CustomerRegistration {
  /** The event's `customerId` (never its `aggregateId`, the user id). */
  id: string;
  /** Display name, or null when the event has none. */
  name: string | null;
  /** Email address; must be non-empty. */
  email: string;
}

/**
 * A customer of the shop, created once from identity.user-registered (US-10) and never updated
 * or deleted. Orders only checks that it exists.
 */
export class Customer {
  private constructor(
    /** Customer id (= the event's `customerId`). */
    readonly id: string,
    /** Display name, or null. */
    readonly name: string | null,
    /** Email address. */
    readonly email: string,
  ) {}

  /**
   * Builds a customer from a registration, stored as received.
   *
   * @throws CustomerValidationError if `id` is not a UUID, `email` is empty after trimming, or
   *   `name` is longer than 100 characters.
   */
  static register({ id, name, email }: CustomerRegistration): Customer {
    if (!UUID_PATTERN.test(id)) {
      throw new CustomerValidationError(`customer id ${id} is not a UUID`);
    }
    if (email.trim().length === 0) {
      throw new CustomerValidationError('customer email must not be empty');
    }
    if (name !== null && name.length > CUSTOMER_NAME_MAX_LENGTH) {
      throw new CustomerValidationError(
        `customer name must be at most ${CUSTOMER_NAME_MAX_LENGTH} characters`,
      );
    }
    return new Customer(id, name, email);
  }
}
