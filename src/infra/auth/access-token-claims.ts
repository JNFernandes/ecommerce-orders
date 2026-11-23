import { Role } from './role.enum';

/**
 * The verified caller, built only by `AccessTokenVerifier` after the signature, issuer, audience
 * and time checks. Frozen; never stored or logged.
 */
export interface AccessTokenClaims {
  /** Identity user id. */
  readonly sub: string;
  /** The caller's customer id (UUID), present for customer users. */
  readonly customerId?: string;
  /** Known roles only; may be empty. */
  readonly roles: readonly Role[];
}

/**
 * Roles that count for access decisions (research R10): `CUSTOMER` counts only when the token
 * carries a `customerId`, so a customer requester always has an id.
 */
export function effectiveRoles(claims: AccessTokenClaims): readonly Role[] {
  return claims.customerId === undefined
    ? claims.roles.filter((role) => role !== Role.CUSTOMER)
    : claims.roles;
}
