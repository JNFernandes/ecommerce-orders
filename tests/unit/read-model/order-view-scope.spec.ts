import {
  EMPTY,
  OrderViewScope,
  scopeOrderFilter,
  scopeOwner,
} from '../../../src/read-model/order-view-scope';
import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';

const OWN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER = '11111111-2222-4333-8444-555555555555';

const ALL: OrderViewScope = { kind: 'ALL' };
const CUSTOMER: OrderViewScope = { kind: 'CUSTOMER', customerId: OWN };

describe('scopeOrderFilter', () => {
  it.each([
    ['no filter', {}],
    ['a status filter', { status: OrderViewStatus.PENDING }],
    ['a customer filter', { customerId: OTHER }],
  ])('should leave %s unchanged for ALL', (_label, filter) => {
    expect(scopeOrderFilter(ALL, filter)).toEqual(filter);
  });

  it('should restrict a customer with no customerId filter to their own orders', () => {
    expect(scopeOrderFilter(CUSTOMER, { status: OrderViewStatus.CONFIRMED })).toEqual({
      status: OrderViewStatus.CONFIRMED,
      customerId: OWN,
    });
  });

  it('should treat a customer filtering by their own id (any case) like no filter', () => {
    expect(scopeOrderFilter(CUSTOMER, { customerId: OWN.toUpperCase() })).toEqual({
      customerId: OWN,
    });
  });

  it('should return EMPTY when a customer filters by another customer id', () => {
    expect(scopeOrderFilter(CUSTOMER, { customerId: OTHER })).toBe(EMPTY);
  });

  it('should return EMPTY for another customer id combined with a status', () => {
    expect(
      scopeOrderFilter(CUSTOMER, { customerId: OTHER, status: OrderViewStatus.CANCELLED }),
    ).toBe(EMPTY);
  });

  it('should not mutate the requested filter', () => {
    const filter = { status: OrderViewStatus.PENDING };

    scopeOrderFilter(CUSTOMER, filter);

    expect(filter).toEqual({ status: OrderViewStatus.PENDING });
  });
});

describe('scopeOwner', () => {
  it('should have no owner for ALL', () => {
    expect(scopeOwner(ALL)).toBeUndefined();
  });

  it('should be the lowercased customer id for CUSTOMER', () => {
    expect(scopeOwner({ kind: 'CUSTOMER', customerId: OWN.toUpperCase() })).toBe(OWN);
  });
});
