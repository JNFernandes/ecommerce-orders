import { AccessTokenClaims, effectiveRoles } from '../infra/auth/access-token-claims';
import { Role } from '../infra/auth/role.enum';

/** Every order in the read model (administrators). */
export interface AllOrdersScope {
  readonly kind: 'ALL';
}

/** Only the orders of one customer (customer callers). */
export interface CustomerOrdersScope {
  readonly kind: 'CUSTOMER';
  /** The caller's customer id, lowercased (UUIDs are case-insensitive, stored ids are lowercase). */
  readonly customerId: string;
}

/**
 * Which orders a read query may return (US-12). A required argument of every order query, so an
 * unscoped read cannot be written. Built only by {@link OrderReadScope.forCaller}.
 */
export type OrderReadScope = AllOrdersScope | CustomerOrdersScope;

/**
 * Thrown when a verified caller has neither `ADMIN` nor `CUSTOMER` with a `customerId`, so no read
 * scope exists. Answered as GraphQL `FORBIDDEN`; there is never a fallback to "all orders".
 */
export class ReadScopeForbiddenError extends Error {
  constructor() {
    super('The caller has no order read scope');
    this.name = 'ReadScopeForbiddenError';
  }
}

const ALL: AllOrdersScope = Object.freeze({ kind: 'ALL' });

/** Factory for {@link OrderReadScope}. */
export const OrderReadScope = Object.freeze({
  /**
   * Derives the read scope from the verified claims, using the effective roles (`CUSTOMER` counts
   * only with a `customerId`): `ADMIN` → all orders (wins over `CUSTOMER`); `CUSTOMER` → the
   * caller's own orders.
   *
   * @throws ReadScopeForbiddenError when the caller has neither role.
   */
  forCaller(claims: AccessTokenClaims): OrderReadScope {
    const roles = effectiveRoles(claims);
    if (roles.includes(Role.ADMIN)) {
      return ALL;
    }
    if (roles.includes(Role.CUSTOMER) && claims.customerId !== undefined) {
      return Object.freeze({ kind: 'CUSTOMER', customerId: claims.customerId.toLowerCase() });
    }
    throw new ReadScopeForbiddenError();
  },
});
