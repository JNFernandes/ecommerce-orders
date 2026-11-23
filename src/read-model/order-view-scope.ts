import { OrderViewFilter } from './order-view.repository';

/**
 * Structural read scope as the read model sees it (the query side's `OrderReadScope` fits it).
 * Declared here so the read model does not depend on callers or on `src/domain`.
 */
export type OrderViewScope =
  { readonly kind: 'ALL' } | { readonly kind: 'CUSTOMER'; readonly customerId: string };

/** Marker: the scoped result is provably empty, so no query needs to run. */
export const EMPTY: unique symbol = Symbol('EMPTY_ORDER_VIEW_SCOPE');

/**
 * Applies a read scope to a requested list filter (US-12, the read-side mirror of
 * `Order.isAccessibleBy`). Pure.
 *
 * - `ALL`: the requested filter, unchanged.
 * - `CUSTOMER(c)` with no `customerId` or `customerId = c`: the filter restricted to `c`.
 * - `CUSTOMER(c)` with `customerId = d ≠ c`: {@link EMPTY} (a customer can never widen or switch
 *   the owner).
 *
 * Customer ids are compared lowercased.
 */
export function scopeOrderFilter(
  scope: OrderViewScope,
  filter: OrderViewFilter,
): OrderViewFilter | typeof EMPTY {
  if (scope.kind === 'ALL') {
    return filter;
  }
  const owner = scope.customerId.toLowerCase();
  if (filter.customerId !== undefined && filter.customerId.toLowerCase() !== owner) {
    return EMPTY;
  }
  return { ...filter, customerId: owner };
}

/** The owner a by-id lookup must match: `undefined` for `ALL`, the lowercased id otherwise. */
export function scopeOwner(scope: OrderViewScope): string | undefined {
  return scope.kind === 'ALL' ? undefined : scope.customerId.toLowerCase();
}
