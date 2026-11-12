---

description: "Task list for US-07 Get Order by Id over GraphQL"
---

# Tasks: Get Order by Id over GraphQL (US-07)

**Input**: Design documents from `specs/005-get-order-by-id/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R6), data-model.md,
contracts/graphql-order-query.md, quickstart.md

**Tests**: REQUIRED by the user's description and constitution Principles V/VI:
- unit tests for the query handler (found and not found);
- integration tests with real GraphQL queries against a MongoDB container;
- a full-flow component test.

Write the tests first and confirm they fail before implementing.

**Organization**: by the three user stories in spec.md:

- **US1** Look up an order by its id (P1)
- **US2** "Not found" is an answer, not an error (P1)
- **US3** Clear error for a malformed id (P2)

**Quality gate (Constitution IX)**: after every task, run `npm run build && npm run lint &&
npm run format:check && npm run test`. **Commit only when the gate exits 0**: chain the commit with
`&&` (or run it inside `if [ $? -eq 0 ]`), never with `;`. Conventional Commits scoped `US-07`.

**Reuse rule (FR-008)**: do not create a new GraphQL `Order` type, repository method, module or
error filter. Use `OrderType`/`OrderType.fromView`, `OrderViewRepository.findById`,
`GraphQLUserInputFilter` (already on `OrdersResolver`), `buildGraphqlOptions` and `configureApp`
as they are. Nothing new may import from `src/domain/`, `src/infra/database/`, `src/repositories/`
or `src/commands/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US3 (foundational and polish tasks have no label)

---

## Phase 1: Setup

No setup work: no new dependencies, configuration or migration (plan.md).

---

## Phase 2: Foundational (Blocking Prerequisites)

- [X] T001 [P] Create `GetOrderArgs` (`@ArgsType()`) in `src/dto/graphql/get-order.args.ts` with `orderId: string`, `@Field(() => ID, { description: 'Order identifier (UUID, any case).' })` and `@IsUUID()`. Add JSDoc. Import only `@nestjs/graphql` and `class-validator`.
- [X] T002 [P] Create `GetOrderQuery` (`constructor(public readonly orderId: string)`, with JSDoc) in `src/queries/get-order.query.ts`.

**Checkpoint**: the build is green.

---

## Phase 3: User Story 1 — Look up an order by its id (Priority: P1) 🎯 MVP

**Goal**: `order(orderId)` returns the order from the read model with the same values as its entry in `orders`, for any letter case of the id. It goes through the `QueryBus` and `GetOrderService` to `OrderViewRepository.findById`.

**Independent Test**: seed a view and query `order(orderId)`. The result deep-equals that order's entry from `orders(...)`. The same id in uppercase returns the same order.

### Tests (write first)

- [X] T003 [P] [US1] Unit tests in `tests/unit/services/get-order.service.spec.ts` (mock `OrderViewRepository.findById`):
  - found → returns `stored.view` (not the `{ view, revision }` wrapper);
  - an uppercase id → `findById` is called with the lowercase id;
  - `ReadModelUnavailableError` from the repository propagates.
- [X] T004 [P] [US1] Extend `tests/unit/controllers/orders.resolver.spec.ts` (`describe('OrdersResolver.order')`):
  - `order(args)` executes exactly one `GetOrderQuery` with `args.orderId`;
  - it maps a returned view with `OrderType.fromView`, with no bookkeeping keys;
  - the resolver still depends only on `QueryBus` (the existing assertion keeps passing).
- [X] T005 [US1] Extend `tests/integration/support/read-model-testing.ts` (`buildGraphqlTestingApp`): add `GetOrderService` to `providers`. In `tests/integration/list-orders.graphql.integration.spec.ts`, add `describe('order by id (US7)')` using the seeded views:
  - `order(orderId: <id of view 5>)` deep-equals `orders(limit: 1, offset: 3).items[0]` (same field set);
  - the order known only from a terminal event (view 8) returns `items`/`totalAmount`/`placedAt` null and status `CONFIRMED`;
  - the same id in uppercase (`orderId(5).toUpperCase()`) returns that order;
  - a `CANCELLED` order (view 9) shows `cancellationReason`.

  Use a variables-based query: `query ($id: ID!) { order(orderId: $id) { …ORDER_FIELDS } }`.
- [X] T006 [US1] Extend `tests/component/list-orders.component.spec.ts`:
  - add `GetOrderService` to `providers`;
  - new case: place an order via `POST /orders`, poll `order(orderId)` over GraphQL (≤ 30s) until `status: PENDING` with its items and total;
  - `POST /orders/:id/confirm`, then poll until `status: CONFIRMED` with `confirmedAt`.

### Implementation

- [X] T007 [US1] Create `GetOrderService` (`@QueryHandler(GetOrderQuery)`, `implements IQueryHandler<GetOrderQuery, OrderView | null>`) in `src/services/get-order.service.ts`. `execute` returns `(await this.repository.findById(query.orderId.toLowerCase()))?.view ?? null`. Add JSDoc stating it reads the read model only, and why the id is lowercased. Register it in `src/app.module.ts` providers. Makes T003 pass.
- [X] T008 [US1] Add to `OrdersResolver` in `src/controllers/orders.resolver.ts`:

  ```
  @Query(() => OrderType, { name: 'order', nullable: true, description: 'Gets one order from the read model by id, or null when no order has that id. Eventually consistent: an order that was just placed may briefly return null until it has been projected.' })
  async order(@Args() args: GetOrderArgs): Promise<OrderType | null>
  ```

  It runs `queryBus.execute(new GetOrderQuery(args.orderId))`, then maps with `OrderType.fromView`, or returns `null`. Makes T004–T006 pass.

**Checkpoint**: MVP. Orders can be fetched by id over GraphQL.

---

## Phase 4: User Story 2 — "Not found" is an answer, not an error (Priority: P1)

**Goal**: an unknown valid UUID returns `{ "data": { "order": null } }` with no `errors` key. A read-model outage stays an error (`SERVICE_UNAVAILABLE`) and never looks like `null`.

**Independent Test**: query a never-used UUID. The response body is exactly `{ data: { order: null } }`.

### Tests (write first)

- [ ] T009 [P] [US2] Extend `tests/unit/services/get-order.service.spec.ts`: `findById` resolves `null`, so `execute` returns `null`. Extend `tests/unit/controllers/orders.resolver.spec.ts`: when the query result is `null`, `order()` returns `null` without calling `OrderType.fromView`.
- [ ] T010 [US2] Extend `tests/integration/list-orders.graphql.integration.spec.ts`:
  - `order(orderId: "99999999-9999-4999-8999-999999999999")` → the response body is `{ data: { order: null } }` and `body.errors` is undefined;
  - in the existing `describe('GraphQL orders query (integration, MongoDB unavailable)')`, add a case: with the container stopped, `order(orderId: <uuid>)` → one error with `extensions.code === 'SERVICE_UNAVAILABLE'`, the generic message, and `data` null (not `{ order: null }`).
- [ ] T011 [US2] Extend `tests/component/list-orders.component.spec.ts`: `order(orderId: <random uuid>)` → `data.order === null` with no errors.

### Implementation

- [ ] T012 [US2] Verify that T007/T008 already satisfy T009–T011 (a `null` passthrough; the outage handled by the existing filter). If any case fails, fix it in `src/services/get-order.service.ts` or `src/controllers/orders.resolver.ts` without adding error handling to the resolver.

**Checkpoint**: not-found and outage are clearly told apart.

---

## Phase 5: User Story 3 — Clear error for a malformed id (Priority: P2)

**Goal**: a non-UUID `orderId` gives `BAD_USER_INPUT` with `orderId must be a UUID`. A missing argument gives `GRAPHQL_VALIDATION_FAILED`. The service keeps serving.

**Independent Test**: `order(orderId: "abc")` returns one `BAD_USER_INPUT` error naming `orderId`, and a valid query sent right after succeeds.

### Tests (write first)

- [ ] T013 [P] [US3] Unit tests in `tests/unit/dto/get-order.args.spec.ts` (`plainToInstance` + `validate`): a lowercase UUID is valid; an uppercase UUID is valid; `'abc'`, `''` and `'123'` are invalid on `orderId`.
- [ ] T014 [US3] Extend `tests/integration/list-orders.graphql.integration.spec.ts`:
  - `order(orderId: "abc")` → `BAD_USER_INPUT`, message `orderId must be a UUID`, `validationErrors` `['orderId must be a UUID']`, `data` null;
  - `{ order { orderId } }` → `GRAPHQL_VALIDATION_FAILED`, with the message mentioning `orderId`;
  - a valid `order(...)` right after succeeds.

### Implementation

- [ ] T015 [US3] Verify that `GetOrderArgs` (T001), the global `ValidationPipe` and `GraphQLUserInputFilter` already produce the expected errors. If the message differs (e.g. the class-validator wording), adjust the test expectation to the actual standard message only if it still names `orderId`. Otherwise fix the decorator in `src/dto/graphql/get-order.args.ts`.

**Checkpoint**: all three stories work.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T016 Run `npm run schema:generate` to update `docs/schema.gql` with the `order` query. Extend `tests/unit/graphql/schema.spec.ts` with an assertion that the printed schema matches `/order\(\s*"""[^"]*"""\s*orderId: ID!\s*\): Order\n/`, i.e. a nullable `Order`. The existing drift and description tests must pass.
- [ ] T017 [P] Update `README.md`: in the GraphQL section, add the `order(orderId)` signature and an example (found, as a variables-based query), plus the not-found response `{ "data": { "order": null } }` and the malformed-id error.
- [ ] T018 [P] Update `CLAUDE.md`: in the read-path line, name both queries (`orders`, `order`) and note that "not found" returns `null` (not an error).
- [ ] T019 [P] Update `src/README.md` ("Where a GraphQL query goes": add `order` → `GetOrderQuery` → `GetOrderService` → `OrderViewRepository.findById`) and `docs/read-model.md` (read by the `orders` **and** `order` queries).
- [ ] T020 Run the full gate plus `npm run test:cov` (thresholds) and `npm run schema:generate && git diff --exit-code docs/schema.gql`.
- [ ] T021 Live validation per `specs/005-get-order-by-id/quickstart.md` on a **separate port** (`PORT=3001 node dist/main`), so the user's dev server is not disturbed:
  - place an order, fetch it by id (`PENDING`, then `CONFIRMED`/`CANCELLED` with Payments running);
  - unknown UUID → `null` with no errors; `abc` → `BAD_USER_INPUT`; uppercase id → found.

  Stop the instance by PID afterwards and record the results for the PR.

---

## Dependencies & Execution Order

- **Foundational (T001–T002)**: [P], no dependencies.
- **US1 (T003–T008)**: needs Foundational. **MVP.** T003 + T004 in parallel, then T005 and T006, then T007 → T008.
- **US2 (T009–T012)**: needs US1 (resolver and handler exist).
- **US3 (T013–T015)**: needs T001 (args). Its integration test needs T008. T013 can start right after Foundational.
- **Polish (T016–T021)**: after all stories. T017–T019 [P].

```text
Foundational ──▶ US1 (MVP) ──┬──▶ US2 ──┐
                             └──▶ US3 ──┴──▶ Polish
```

## Parallel Examples

- T001 + T002.
- T003 + T004 (+ T013).
- T017 + T018 + T019.

## Implementation Strategy

1. **MVP = Foundational + US1**: fetch an order by id over GraphQL.
2. **US2**: `null` for unknown ids, and outages kept distinct from not-found.
3. **US3**: a malformed-id error.
4. **Polish**: schema file, docs, gate, live check.
