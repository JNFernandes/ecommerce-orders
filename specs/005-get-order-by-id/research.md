# Research: Get Order by Id over GraphQL (US-07)

Phase 0 output for [plan.md](plan.md). Everything builds on US-06's GraphQL read path; the code
paths below were checked in the current `main` (US-06 merged, PR #5).

---

## R1. Repository lookup: reuse the existing `findById`

**Finding**: `OrderViewRepository.findById(orderId): Promise<StoredOrderView | null>` already
exists (added in US-05; used by `OrderProjectionService`). It reads by document `_id` (the order
id) with `lean()`, maps the document to `OrderView`, and is wrapped by `guard`, so an outage
becomes `ReadModelUnavailableError`. Its result is `{ view, revision }`.

**Decision**: Reuse it as is. `GetOrderService` returns `stored?.view ?? null`. No new repository
method, no index (the `_id` primary key serves the lookup, which meets SC-005), and no migration.

**Rationale**: This follows the user's "reuse OrderViewRepository" and FR-008 (no duplication).
The user's plan input mentions "a findById method on the repository"; it already exists, so the
plan reuses it rather than adding a second lookup method.

**Alternatives considered**: a new `findViewById` returning only the view. It is a trivial
wrapper, but it would duplicate the lookup and the error mapping.

---

## R2. Query and handler

**Decision**:
- `GetOrderQuery(orderId: string)` in `src/queries/get-order.query.ts`.
- `GetOrderService` (`@QueryHandler(GetOrderQuery)`) in `src/services/get-order.service.ts`. It
  lower-cases the id (FR-004: UUIDs are case-insensitive and stored ids are lowercase), calls
  `repository.findById`, and returns `OrderView | null`.

The handler, not the resolver, does the normalisation, so every caller of the query gets the
same behaviour.

**Rationale**: This mirrors `ListOrdersQuery` / `ListOrdersService` (US-06) and keeps the resolver
to I/O and mapping (Principle I).

---

## R3. Resolver method and nullability

**Decision**: Add `order(@Args() args: GetOrderArgs)` to the **existing** `OrdersResolver`:
- `@Query(() => OrderType, { name: 'order', nullable: true, description })`;
- dispatch `GetOrderQuery` on the `QueryBus`;
- map with `OrderType.fromView`, or return `null`.

It inherits the class-level `@UseFilters(GraphQLUserInputFilter)`.

The schema becomes `order(orderId: ID!): Order`. Apollo answers a `null` result as
`{ "data": { "order": null } }` with no `errors` key (FR-003).

**Rationale**: One resolver per GraphQL type (`Order`), and FR-008 reuse of the error filter and
the `Order` type.

---

## R4. Argument validation

**Decision**: `GetOrderArgs` (`@ArgsType()`, `src/dto/graphql/get-order.args.ts`):
`@Field(() => ID, { description })` with `@IsUUID()` on `orderId`. The global `ValidationPipe`
(`configureApp`) validates it, and `GraphQLUserInputFilter` turns the `BadRequestException` into
`BAD_USER_INPUT` with the message `orderId must be a UUID` (FR-005).

A missing argument never reaches the pipe: GraphQL rejects `order { … }` without `orderId` because
of `ID!` (`GRAPHQL_VALIDATION_FAILED`).

**Rationale**: These are the same mechanics proven in US-06 for `customerId`, so no new error
handling is needed.

---

## R5. Schema description (eventual consistency)

**Decision**: The query description reads: *"Gets one order from the read model by id, or null when
no order has that id. Eventually consistent: an order that was just placed may briefly return null
until it has been projected."* The argument description reads: *"Order identifier (UUID, any
case)."*

The existing `tests/unit/graphql/schema.spec.ts` already fails on any undescribed field or
argument and on `docs/schema.gql` drift, so `npm run schema:generate` must be re-run (FR-009/010).

---

## R6. Tests

**Decision**:
- **Unit**:
  - `tests/unit/services/get-order.service.spec.ts`: found returns the view; not found returns
    `null`; an uppercase id is looked up in lowercase; repository errors propagate.
  - `tests/unit/controllers/orders.resolver.spec.ts` (extended): `order()` dispatches exactly one
    `GetOrderQuery`, maps with `OrderType.fromView`, and returns `null` when the handler returns
    `null`.
  - `tests/unit/dto/get-order.args.spec.ts`: a UUID is valid; `abc` and an empty string are
    invalid.
  - The schema test is extended to assert `order(orderId: ID!): Order`.
- **Integration**: extend `tests/integration/list-orders.graphql.integration.spec.ts` (it already
  builds the GraphQL app on a MongoDB container and seeds views) with a `describe('order by id')`:
  - a found order whose fields deep-equal its entry from `orders`;
  - a view without `placedAt`;
  - an unknown UUID → `data.order === null` and no `errors` key;
  - `"abc"` → `BAD_USER_INPUT` naming `orderId`;
  - a missing argument → `GRAPHQL_VALIDATION_FAILED`;
  - an uppercase id → found;
  - an outage → `SERVICE_UNAVAILABLE` (in the existing "MongoDB unavailable" describe).
- **Component**: extend `tests/component/list-orders.component.spec.ts`. Place an order via REST,
  poll `order(orderId)` until it is `PENDING` with its items, confirm it via REST, then poll until
  it is `CONFIRMED` with `confirmedAt`. An unknown UUID → `null`.

**Rationale**: Principles V/VI and the user's test list, reusing the US-06 harnesses instead of
duplicating container setup.
