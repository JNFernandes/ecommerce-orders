import { effectiveRoles } from '../../../../src/infra/auth/access-token-claims';
import { parseRoles, Role } from '../../../../src/infra/auth/role.enum';

describe('parseRoles', () => {
  it('keeps known roles and drops unknown ones', () => {
    expect(parseRoles(['CUSTOMER', 'SUPPORT', 'ADMIN'])).toEqual([Role.CUSTOMER, Role.ADMIN]);
  });

  it('is case-sensitive and removes duplicates', () => {
    expect(parseRoles(['admin', 'ADMIN', 'ADMIN'])).toEqual([Role.ADMIN]);
  });

  it('returns no roles for an empty or unknown-only list', () => {
    expect(parseRoles([])).toEqual([]);
    expect(parseRoles(['SUPPORT'])).toEqual([]);
  });
});

describe('effectiveRoles', () => {
  it('keeps CUSTOMER when the token has a customerId', () => {
    expect(effectiveRoles({ sub: 'u', customerId: 'c', roles: [Role.CUSTOMER] })).toEqual([
      Role.CUSTOMER,
    ]);
  });

  it('drops CUSTOMER when the token has no customerId', () => {
    expect(effectiveRoles({ sub: 'u', roles: [Role.CUSTOMER, Role.ADMIN] })).toEqual([Role.ADMIN]);
  });

  it('keeps ADMIN with or without a customerId', () => {
    expect(effectiveRoles({ sub: 'u', roles: [Role.ADMIN] })).toEqual([Role.ADMIN]);
  });
});
