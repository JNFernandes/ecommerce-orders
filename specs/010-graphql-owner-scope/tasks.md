# Tasks: Scope the GraphQL Read Model by Owner (US-12)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/graphql-scoping.md](contracts/graphql-scoping.md)

**Tests**: required (constitution V/VI). Tests are written next to the code they cover, in the same task.

**Quality gate after every task**: `npm run build` → `npm run lint` → `npm run format:check` →
`npm run test` (component suites need Docker).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 customer list, US2 customer by id, US3 admin, US4 forbidden

---

## Phase 1: Setup

Nothing to do: branch `feature/US-12-graphql-owner-scope` exists, no new dependency.

---

## Phase 2: Foundational (blocks every story)

- [X] T001 [P] Create `OrderReadScope` (`{kind:'ALL'} | {kind:'CUSTOMER', customerId}`, lowercased id), `OrderReadScope.forCaller(claims: AccessTokenClaims)` using `effectiveRoles` (ADMIN wins; neither → throw `ReadScopeForbiddenError`) in `src/queries/order-read-scope.ts`, with JSDoc; unit tests (admin, customer, admin+customer, CUSTOMER without customerId, no roles, uppercase id lowercased) in `tests/unit/queries/order-read-scope.spec.ts`
- [X] T002 [P] Create pure `scopeOrderFilter(scope, filter): OrderViewFilter | typeof EMPTY` per data-model table in `src/read-model/order-view-scope.ts` (structural scope type only, no import from `src/domain`; compare ids lowercased); unit tests (ALL unchanged, own id, no id, conflicting id → EMPTY, conflicting id + status → EMPTY) in `tests/unit/read-model/order-view-scope.spec.ts`
- [X] T003 Add required first constructor arg `scope: OrderReadScope` to `ListOrdersQuery` in `src/queries/list-orders.query.ts` and `GetOrderQuery` in `src/queries/get-order.query.ts`; in `src/controllers/orders.resolver.ts` take `@CurrentUser()` claims → `OrderReadScope.forCaller` → dispatch (no filtering in resolver); map `ReadScopeForbiddenError` → `forbiddenError()` (`FORBIDDEN`) in `src/graphql/graphql-user-input.filter.ts`; fix existing callers/tests so they compile (handlers may ignore scope until T004/T007)

**Checkpoint**: build green, every query carries a scope.

---

## Phase 3: US1 – Customer lists only their own orders (P1) 🎯 MVP

**Independent test**: orders for A and B; A lists with no filter, status filter, paging, own id, B's id → only A's orders, totals/hasNextPage over A's only, B's id → empty, total 0, no error.

- [X] T004 [US1] In `src/services/list-orders.service.ts` apply `scopeOrderFilter`; `EMPTY` → `{ views: [], totalCount: 0 }` without calling the repository; otherwise pass the effective filter to `OrderViewRepository.list` (same filter for find and count); extend `tests/unit/services/list-orders.service.spec.ts` (customer, own id, conflicting id → no repo call, admin passthrough)
- [X] T005 [P] [US1] Add index `{ customerId: 1, status: 1, placedAt: -1, _id: -1 }` named `customerId_status_placedAt` in `src/read-model/order-view.schema.ts`; in `tests/integration/order-view.repository.integration.spec.ts` assert the index exists after `ensureIndexes()` and `explain()` shows IXSCAN (no COLLSCAN) for owner and owner+status list/count, plus scoped paging totals
- [X] T006 [US1] Create `tests/component/graphql-owner-scope.component.spec.ts` (full app, `withTestIdentity()` tokens, orders projected for A and B) covering US1 acceptance 1–5 and edge cases (customer with no orders, offset past end, B's id + status/paging)

---

## Phase 4: US2 – Customer can only open their own order (P1)

**Independent test**: A asks for own order X → X; B's order Y → `{"data":{"order":null}}`, no errors; unknown Z → identical response.

- [X] T007 [US2] Add `findOne(orderId, customerId?)` (query `{ _id, customerId? }`, keep `findById` for projection) in `src/read-model/order-view.repository.ts` with an integration case in `tests/integration/order-view.repository.integration.spec.ts`; use it in `src/services/get-order.service.ts` (CUSTOMER → pass customerId, ALL → none); extend `tests/unit/services/get-order.service.spec.ts` (own, foreign → null, admin)
- [X] T008 [US2] Add US2 scenarios 1–3 to `tests/component/graphql-owner-scope.component.spec.ts`, asserting the foreign-id and unknown-id response bodies are byte-identical

---

## Phase 5: US3 – Administrator sees all orders (P2)

**Independent test**: admin lists all, filters by A → A's only, opens B's order.

- [X] T009 [US3] Add admin scenarios 1–3 (and admin+customerId token behaves as admin) to `tests/component/graphql-owner-scope.component.spec.ts`; make `tests/integration/list-orders.graphql.integration.spec.ts` and `tests/component/list-orders.component.spec.ts` call as admin so existing expectations stay unchanged (SC-004)

---

## Phase 6: US4 – No owner, no admin → FORBIDDEN (P2)

**Independent test**: CUSTOMER token without customerId and a no-role token get `FORBIDDEN` on both queries, with no order data (`orders` → `data: null`, nullable `order` → `{"order": null}`).

- [X] T010 [US4] Add FORBIDDEN cases (CUSTOMER without customerId, no roles) for `orders` and `order`, plus no token → `UNAUTHENTICATED` (HTTP 200) and invalid args → `BAD_USER_INPUT`, to `tests/component/graphql-owner-scope.component.spec.ts`; assert no token material in captured logs/error bodies (SC-006)

---

## Phase 7: Polish

- [X] T011 [P] Update GraphQL `description`s of `orders`, `order` and the `customerId` arg (scoping rules) in `src/controllers/orders.resolver.ts` / `src/dto/graphql/`; run `npm run schema:generate` and commit `docs/schema.gql` (descriptions only)
- [X] T012 [P] Docs: README access table + "who sees what" with GraphQL examples, drop "not scoped until US-12" in `README.md` and `CLAUDE.md`; add scoping rule + new index to `docs/read-model.md`
- [X] T013 Run the full quality gate and the automated part of `quickstart.md`; tick tasks
  - **Result (2026-11-23)**: gate green (827 tests, 86 suites). Manual quickstart: this branch's
    build on port 3010 (Kafka consumers and dead-letter retry off; the `:3000` container's
    projection fed the shared MongoDB) with real Identity customer tokens for two newly registered
    customers A and B (inserted into `customers` by hand: the `:3000` image predates US-10).
    Steps 1, 2, 3, 4 and 6 pass: A sees only A's 2 orders; A filtering by B's id gets
    `{"totalCount":0,"hasNextPage":false,"items":[]}`; A asking for B's order and for an unknown id
    get byte-identical `{"data":{"order":null}}`; no token → `UNAUTHENTICATED`, HTTP 200, no data;
    no token fragment in the logs. Step 5 (admin) not run live (no admin credentials); covered by
    the US3 component and integration tests with signed admin tokens.

---

## Dependencies

- T001, T002 → T003 → all stories. T001 ∥ T002.
- US1 (T004–T006) and US2 (T007–T008) are independent after T003; T005 ∥ T004.
- US3/US4 need T004 + T007 (they test both queries). T006 → T008 → T009 → T010 append to the same component spec, so run them in sequence.
- Polish after stories; T011 ∥ T012.

## Parallel examples

- Foundational: T001 ∥ T002.
- US1: T004 ∥ T005, then T006.
- Polish: T011 ∥ T012.

## Implementation strategy

1. MVP = Phase 2 + US1 (closes the list leak). Gate, commit `feat(US-12): ...`.
2. Add US2 (closes the by-id leak). Gate, commit.
3. US3 + US4 regression/guard tests, then Polish. Gate, commit, PR "Implements US-12".
