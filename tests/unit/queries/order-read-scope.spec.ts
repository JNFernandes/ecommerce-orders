import { OrderReadScope, ReadScopeForbiddenError } from '../../../src/queries/order-read-scope';
import { AccessTokenClaims } from '../../../src/infra/auth/access-token-claims';
import { Role } from '../../../src/infra/auth/role.enum';

const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function claims(roles: Role[], customerId?: string): AccessTokenClaims {
  return customerId === undefined ? { sub: 'user-1', roles } : { sub: 'user-1', roles, customerId };
}

describe('OrderReadScope.forCaller', () => {
  it('should give an admin every order', () => {
    expect(OrderReadScope.forCaller(claims([Role.ADMIN]))).toEqual({ kind: 'ALL' });
  });

  it('should give a customer only their own orders', () => {
    expect(OrderReadScope.forCaller(claims([Role.CUSTOMER], CUSTOMER_ID))).toEqual({
      kind: 'CUSTOMER',
      customerId: CUSTOMER_ID,
    });
  });

  it('should let ADMIN win over CUSTOMER when the token has both and a customerId', () => {
    expect(OrderReadScope.forCaller(claims([Role.CUSTOMER, Role.ADMIN], CUSTOMER_ID))).toEqual({
      kind: 'ALL',
    });
  });

  it('should refuse a CUSTOMER token without a customerId', () => {
    expect(() => OrderReadScope.forCaller(claims([Role.CUSTOMER]))).toThrow(
      ReadScopeForbiddenError,
    );
  });

  it('should refuse a token without any known role, even with a customerId', () => {
    expect(() => OrderReadScope.forCaller(claims([], CUSTOMER_ID))).toThrow(
      ReadScopeForbiddenError,
    );
  });

  it('should lowercase the customer id', () => {
    expect(OrderReadScope.forCaller(claims([Role.CUSTOMER], CUSTOMER_ID.toUpperCase()))).toEqual({
      kind: 'CUSTOMER',
      customerId: CUSTOMER_ID,
    });
  });

  it('should return an immutable scope', () => {
    expect(Object.isFrozen(OrderReadScope.forCaller(claims([Role.CUSTOMER], CUSTOMER_ID)))).toBe(
      true,
    );
    expect(Object.isFrozen(OrderReadScope.forCaller(claims([Role.ADMIN])))).toBe(true);
  });
});
