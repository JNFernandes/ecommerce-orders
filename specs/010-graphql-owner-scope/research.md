# Research: Scope the GraphQL Read Model by Owner (US-12)

No open NEEDS CLARIFICATION. Decisions:

**R1 Scope value object.** `OrderReadScope` = `{ kind: 'ALL' }` | `{ kind: 'CUSTOMER', customerId }`,
built only by `OrderReadScope.forCaller(claims)` from the verified `AccessTokenClaims`
(`effectiveRoles`). ADMIN wins over CUSTOMER. Why: one place decides scope; a required constructor
argument of both query objects makes an unscoped query impossible to write.

**R2 No scope → FORBIDDEN.** `forCaller` throws `ReadScopeForbiddenError` when there is neither
ADMIN nor CUSTOMER-with-customerId; `GraphQLUserInputFilter` maps it to `FORBIDDEN` (same
`forbiddenError()` as `RolesGuard`). Why: `RolesGuard` already refuses these callers; this is
defence in depth so no fallback to "all" exists. Alternative (return null scope) rejected: easy to
treat as unscoped.

**R3 Where the scope is applied.** Pure `scopeOrderFilter(scope, filter)` in `src/read-model/`
returns the effective `OrderViewFilter` or `EMPTY` (customer asked for another customerId). Query
handlers call it, then the repository. Why: the rule is testable without I/O, read-model keeps no
dependency on `src/domain` (CQRS rule), handlers stay orchestration.

**R4 Conflicting customerId.** Customer filter ≠ own id → empty page, `totalCount` 0,
`hasNextPage` false, no DB call; equal id → same as no filter. Why: spec FR-003/FR-004 (the
argument is ignored for widening, never used to switch owner); skipping the query is correct
because the scoped result set is provably empty.

**R5 Scoped list/count.** Scope's `customerId` is merged into the Mongo filter used by both
`find` and `countDocuments` in `OrderViewRepository.list`. Why: FR-002, totals and paging come from
the same scoped filter. Post-filtering rejected (wrong totals).

**R6 Scoped by-id.** New `OrderViewRepository.findOne(orderId, customerId?)` querying
`{ _id, customerId }`; `findById` stays for the projection. Another owner's order → `null`,
indistinguishable from unknown. Why: one query, no existence leak (no load-then-compare branch).

**R7 Index.** Add `{ customerId: 1, status: 1, placedAt: -1, _id: -1 }` (`customerId_status_placedAt`)
to `OrderViewSchema`; created by the existing `ensureIndexes()`. Owner-only queries use the existing
`customerId_placedAt`; by-id uses `_id`. Verified with `explain()` (IXSCAN, no COLLSCAN) in
integration tests (SC-005).

**R8 Id case.** Scope and filter customer ids compared lowercased, as order ids already are. Why:
UUIDs are case-insensitive; stored ids are lowercase.

**R9 Resolver.** `@CurrentUser()` claims → `OrderReadScope.forCaller` → query → result. No
filtering in the resolver. Why: CLAUDE.md layering; `@CurrentUser()` is the only user access.

**R10 Schema.** Only descriptions of `orders`, `order` and `customerId` change; regenerate
`docs/schema.gql`. Why: FR-011.

**R11 No ADR.** The rule mirrors `Order.isAccessibleBy` on the read side; recorded in
`docs/read-model.md` and README, not a new architectural decision.
