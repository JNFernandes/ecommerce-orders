---

description: "Task list template for feature implementation"
---

# Tasks: Place an Order

**Input**: Design documents from `specs/001-place-order/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included and REQUIRED — the project constitution (Principle V/VI) mandates unit tests for every domain method and handler plus integration/component coverage, and `docs/us-01-place-order.md` enumerates specific tests (UT-01…UT-12, IT-01…IT-08, CT-01…CT-04) that the Definition of Done requires passing.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are included in each description

## Path Conventions

Single NestJS project (per plan.md Structure Decision): `src/` and `tests/` at repository root, organized by bounded context (`orders/`, `customers/`) and DDD layer (`presentation/`, `application/`, `domain/`, `infrastructure/`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Greenfield project initialization — this repository has no `src/` yet.

- [X] T001 Initialize NestJS project scaffold (`package.json`, `nest-cli.json`, `tsconfig.json` with `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`) at repository root
- [X] T002 [P] Install runtime dependencies (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/cqrs`, `@nestjs/swagger`, `@nestjs/typeorm`, `@nestjs/config`, `@nestjs/graphql`, `@apollo/server`, `typeorm`, `pg`, `kafkajs`, `class-validator`, `class-transformer`) in `package.json`
- [X] T003 [P] Install dev/test dependencies (`jest`, `ts-jest`, `@nestjs/testing`, `supertest`, `testcontainers`, `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `prettier`) in `package.json`
- [X] T004 [P] Configure ESLint with `@typescript-eslint/no-explicit-any`, `@typescript-eslint/explicit-function-return-type`, `@typescript-eslint/no-unused-vars`, and `prettier/prettier` as errors in `.eslintrc.js`
- [X] T005 [P] Configure Prettier formatting rules in `.prettierrc`
- [X] T006 [P] Add `docker-compose.yml` with PostgreSQL and Kafka (KRaft mode) services for local development
- [X] T007 Configure `@nestjs/config` environment module for DB and Kafka connection settings in `src/config/configuration.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before any user story can be implemented or independently tested.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T008 Create `OrderStatus` enum (`PENDING`, `CONFIRMED`, `CANCELLED`) in `src/orders/domain/order-status.enum.ts`
- [X] T009 [P] Create `Customer` TypeORM entity (minimal reference: `id`) in `src/customers/infrastructure/persistence/customer.entity.ts`
- [X] T010 [P] Create `Order` TypeORM entity (`id`, `customerId`, `status`, `totalAmount`, `createdAt`, `updatedAt`) in `src/orders/infrastructure/persistence/order.entity.ts`
- [X] T011 [P] Create `OrderItem` TypeORM entity with a unique constraint on (`orderId`, `productId`) in `src/orders/infrastructure/persistence/order-item.entity.ts`
- [X] T012 [P] Create `OrdersRead` TypeORM entity (denormalized read row per data-model.md) in `src/orders/infrastructure/projections/orders-read.entity.ts`
- [X] T013 [P] Create `OrderDeadLetter` TypeORM entity (`eventId`, `topic`, `payload`, `error`, `retryCount`, `createdAt`) in `src/orders/infrastructure/persistence/order-dead-letter.entity.ts`
- [X] T014 Create TypeORM migration creating `customers`, `orders`, `order_items`, `orders_read`, `order_dead_letters` tables in `src/migrations/` (depends on T009-T013)
- [X] T015 Create a seed script inserting at least one test customer row for local dev and integration/component tests in `src/scripts/seed-customers.ts` (depends on T014) — kept out of `src/migrations/` so TypeORM's migration glob doesn't try to load it as a migration
- [X] T016 Implement `CustomerRepository.existsById(customerId): Promise<boolean>` in `src/customers/infrastructure/persistence/customer.repository.ts` (depends on T009, T014)
- [X] T017 Configure `KafkaModule` wrapping a `kafkajs` producer/consumer client in `src/kafka/kafka.module.ts`
- [X] T018 Wire `TypeOrmModule`, `CqrsModule`, `KafkaModule`, and the config module together in `src/app.module.ts` (depends on T007, T014, T017)
- [X] T019 Configure a global `ValidationPipe` (`whitelist`, `transform`, `forbidNonWhitelisted`) and Swagger/OpenAPI bootstrap in `src/main.ts`

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Place an order with valid items (Priority: P1) 🎯 MVP

**Goal**: A customer submits an order with one or more valid items for an existing customer; the order is durably saved as `PENDING` with the correct total, the customer is confirmed, and other parts of the business are notified.

**Independent Test**: `POST /orders` with a valid, existing `customerId` and valid items returns `201` with an `orderId`; the order and its (consolidated) items exist in the write database; the order later appears in the read model.

### Tests for User Story 1 ⚠️

> Write these tests FIRST; confirm they fail before implementing the corresponding code.

- [X] T020 [P] [US1] Unit tests for `Order.place()` happy path — PENDING status (UT-01), totalAmount calculation (UT-02), raises `OrderPlaced` (UT-03), consolidates duplicate `productId` entries into one line item (UT-11) — in `tests/unit/orders/order.aggregate.spec.ts`
- [X] T021 [P] [US1] Unit tests for `PlaceOrderService` happy path — saves to DB before publishing to Kafka (UT-07), returns `orderId` after successful save (UT-09) — in `tests/unit/orders/place-order.service.spec.ts`
- [X] T022 [P] [US1] Integration tests for `POST /orders` happy path — valid payload returns 201 + orderId (IT-01), order saved correctly to write DB (IT-06), duplicate `productId` entries consolidated into one row (IT-08) — in `tests/integration/orders/place-order.integration.spec.ts`
- [X] T023 [P] [US1] Component tests — full write flow: DB saved → `OrderPlaced` emitted to Kafka (CT-01); order appears in read model after projection processes `OrderPlaced` (CT-03) — in `tests/component/orders/place-order.component.spec.ts`

### Implementation for User Story 1

- [X] T024 [P] [US1] Implement `OrderItem` value object (`productId`, `quantity`, `unitPrice`, `subtotal`) in `src/orders/domain/order-item.value-object.ts`
- [X] T025 [US1] Implement `OrderPlaced` domain event class with JSDoc on every field (matches contracts/event-order-placed.md) in `src/orders/domain/events/order-placed.event.ts` (depends on T024)
- [X] T026 [US1] Implement `Order` aggregate root `place()`: consolidate duplicate `productId` items, compute `totalAmount`, set status `PENDING`, raise `OrderPlaced` in `src/orders/domain/order.aggregate.ts` (depends on T008, T024, T025)
- [X] T027 [P] [US1] Implement `PlaceOrderDto` (shape only: `customerId`, `items[]`) with Swagger annotations in `src/orders/presentation/rest/dto/place-order.dto.ts`
- [X] T028 [US1] Implement `PlaceOrderCommand` in `src/orders/application/commands/place-order/place-order.command.ts`
- [X] T029 [US1] Implement `OrderRepository.save()` persisting `Order` + consolidated `OrderItem`s to PostgreSQL in `src/orders/infrastructure/persistence/order.repository.ts` (depends on T010, T011)
- [X] T030 [US1] Implement `OrderEventsProducer.publish()` sending the `OrderPlaced` payload to Kafka topic `orders.order-placed` in `src/orders/infrastructure/kafka/order-events.producer.ts` (depends on T017, T025)
- [X] T031 [US1] Implement `PlaceOrderService` orchestrating: verify customer exists → `Order.place()` → `OrderRepository.save()` → `OrderEventsProducer.publish()` → return `orderId` in `src/orders/application/commands/place-order/place-order.service.ts` (depends on T016, T026, T028, T029, T030)
- [X] T032 [US1] Implement `OrdersController` with `POST /orders` dispatching `PlaceOrderCommand` via the command bus, with Swagger annotations, in `src/orders/presentation/rest/orders.controller.ts` (depends on T027, T031)
- [X] T033 [US1] Implement `OrderProjection` Kafka consumer updating `orders_read` from `OrderPlaced`, idempotent on `eventId` in `src/orders/infrastructure/projections/order.projection.ts` (depends on T012, T017, T025)
- [X] T034 [US1] Register `OrdersModule` (controller, handler, repository, producer, projection) and import it into `AppModule` in `src/orders/orders.module.ts` (depends on T032, T033)
- [X] T035 [US1] Add JSDoc to `Order`, `OrderItem`, `OrderPlaced`, `PlaceOrderService`, and `OrdersController` per the constitution's documentation standard

**Checkpoint**: User Story 1 is fully functional and independently testable — a valid order for an existing customer can be placed end-to-end.

---

## Phase 4: User Story 2 - Receive clear feedback on invalid order submissions (Priority: P2)

**Goal**: Submissions with a missing/unknown customer, no items, or invalid item fields are rejected with a specific, actionable error and no order is created.

**Independent Test**: `POST /orders` with a missing customer id, an unknown customer id, an empty `items` array, or an invalid item returns `400`/`404` with an error identifying the problem, and no row is created in `orders`.

### Tests for User Story 2 ⚠️

- [X] T036 [P] [US2] Unit tests for `Order.place()` validation errors — throws on empty items (UT-04), non-positive quantity (UT-05), non-positive unitPrice (UT-06) — in `tests/unit/orders/order.aggregate.spec.ts`
- [X] T037 [P] [US2] Unit test for `PlaceOrderService` — rejects and does not call `Order.place()` when `customerId` does not correspond to an existing customer (UT-12) — in `tests/unit/orders/place-order.service.spec.ts`
- [X] T038 [P] [US2] Integration tests for `POST /orders` validation errors — missing customerId (IT-02), invalid quantity (IT-03), invalid unitPrice (IT-04), empty items array (IT-05), unknown customerId returns 404 (IT-07) — in `tests/integration/orders/place-order.integration.spec.ts`

### Implementation for User Story 2

- [X] T039 [US2] Add `class-validator` decorators to `PlaceOrderDto` enforcing non-empty `items`, required non-empty `productId`, positive integer `quantity`, positive `unitPrice`, and a valid UUID `customerId` in `src/orders/presentation/rest/dto/place-order.dto.ts` (depends on T027)
- [X] T040 [US2] Add domain validation (throw on empty items after consolidation, non-positive quantity/unitPrice) to `Order.place()` in `src/orders/domain/order.aggregate.ts` (depends on T026)
- [X] T041 [US2] Add the customer-existence check to `PlaceOrderService` — call `CustomerRepository.existsById()` and throw a `NotFoundException` before calling `Order.place()` — in `src/orders/application/commands/place-order/place-order.service.ts` (depends on T031, T016)
- [X] T042 [US2] Map domain validation errors to `HTTP 400` and the not-found case to `HTTP 404` in `src/orders/presentation/rest/orders.controller.ts` (depends on T032)

**Checkpoint**: User Stories 1 and 2 both work independently — valid orders succeed, invalid ones are clearly rejected.

---

## Phase 5: User Story 3 - Trust that a placed order is never lost (Priority: P3)

**Goal**: A durably saved order is never lost or falsely un-confirmed due to a downstream Kafka failure; a DB save failure never falsely confirms an order.

**Independent Test**: Force a Kafka publish failure after a successful DB save — the client still receives `201` and a row appears in `order_dead_letters`. Force a DB save failure — the client receives `500` and no Kafka message is ever sent.

### Tests for User Story 3 ⚠️

- [X] T043 [P] [US3] Unit tests for `PlaceOrderService` resilience — does NOT publish to Kafka if DB save fails (UT-08), stores the event in the dead-letter table if Kafka publish fails (UT-10) — in `tests/unit/orders/place-order.service.spec.ts`
- [X] T044 [P] [US3] Component tests — Kafka publish failure does not return 500 to the client (CT-02); unknown customerId is rejected before DB save and before Kafka publish, neither occurs (CT-04) — in `tests/component/orders/place-order.component.spec.ts`

### Implementation for User Story 3

- [X] T045 [US3] Implement `OrderDeadLetterRepository` to persist failed publish attempts in `src/orders/infrastructure/persistence/order-dead-letter.repository.ts` (depends on T013)
- [X] T046 [US3] Wrap the `OrderEventsProducer.publish()` call in `PlaceOrderService` with try/catch: log the error, persist via `OrderDeadLetterRepository`, and still return the `orderId`/201 in `src/orders/application/commands/place-order/place-order.service.ts` (depends on T030, T031, T045)
- [X] T047 [US3] Ensure a DB save failure in `PlaceOrderService` propagates as `HTTP 500` and short-circuits before any Kafka publish attempt, in `src/orders/application/commands/place-order/place-order.service.ts` and `src/orders/presentation/rest/orders.controller.ts` (depends on T031, T042)

**Checkpoint**: All three user stories are independently functional; the full write-flow resilience guarantee (Principle III/VII) is in place.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and quality gates spanning all user stories (constitution Documentation Standards + Principle IX).

- [X] T048 [P] Add `src/orders/README.md` describing the module's responsibility, exposed endpoint, and domain events produced/consumed
- [X] T049 [P] Document the `OrderPlaced` Kafka event payload in `docs/events/order-placed.md`
- [X] T050 Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm run test`; fix any failures (Principle IX gate — must pass before considering the feature done)
- [X] T051 Run all `quickstart.md` validation scenarios end-to-end against the `docker-compose` environment

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion. No dependency on US2/US3.
- **User Story 2 (Phase 4)**: Depends on Foundational completion; its implementation tasks extend files US1 already created (`PlaceOrderDto`, `Order.place()`, `PlaceOrderService`, `OrdersController`), so in practice complete US1 first.
- **User Story 3 (Phase 5)**: Depends on Foundational completion; its implementation tasks extend `PlaceOrderService`/`OrdersController` from US1, so in practice complete US1 first.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Independently testable after Foundational. This is the MVP.
- **User Story 2 (P2)**: Independently testable after Foundational + US1 (shares `PlaceOrderService`/`PlaceOrderDto`/`OrdersController` files with US1; sequenced after US1 to avoid file conflicts, but adds no new behavior US1 depends on).
- **User Story 3 (P3)**: Independently testable after Foundational + US1 (same file-sharing rationale as US2). Independent of US2.

### Within Each User Story

- Tests written and failing before implementation.
- Domain (`Order`, `OrderItem`, `OrderPlaced`) before application (`PlaceOrderService`) before presentation (`OrdersController`).
- Repository/producer/projection (infrastructure) can proceed in parallel with domain work, wired together in the handler.
- Story complete before moving to the next priority.

### Parallel Opportunities

- All Setup tasks marked [P] (T002-T006) can run in parallel.
- All Foundational entity tasks marked [P] (T009-T013) can run in parallel; migration/seed/wiring tasks after them are sequential.
- Within US1, test tasks T020-T023 (four different files) can run in parallel; T024, T027 (different files, no shared dependencies yet) can run in parallel.
- Within US2 and US3, the listed test tasks (different files) can run in parallel with each other.
- US2 and US3 implementation tasks both touch `place-order.service.ts` and `orders.controller.ts` — do not run US2 and US3 implementation tasks in parallel with each other; sequence one after the other.

---

## Parallel Example: User Story 1

```bash
# Launch all four test-writing tasks for US1 together:
Task: "Unit tests for Order.place() happy path in tests/unit/orders/order.aggregate.spec.ts"
Task: "Unit tests for PlaceOrderService happy path in tests/unit/orders/place-order.service.spec.ts"
Task: "Integration tests for POST /orders happy path in tests/integration/orders/place-order.integration.spec.ts"
Task: "Component tests for full write flow in tests/component/orders/place-order.component.spec.ts"

# Launch independent early implementation tasks together:
Task: "Implement OrderItem value object in src/orders/domain/order-item.value-object.ts"
Task: "Implement PlaceOrderDto in src/orders/presentation/rest/dto/place-order.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (critical — blocks all stories; note this already includes the `customers` table + `CustomerRepository`, since even US1's happy-path test requires an existing customer to place an order against).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Run the US1 independent test — place a valid order end-to-end, confirm DB row + Kafka event + read-model projection.
5. Deploy/demo if ready — this is a usable MVP (a real customer can place a real order).

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add User Story 1 → test independently → deploy/demo (MVP!).
3. Add User Story 2 → test independently → deploy/demo (adds validation feedback).
4. Add User Story 3 → test independently → deploy/demo (adds the durability/resilience guarantee).
5. Polish → documentation, quality gates, quickstart validation.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks in the same batch.
- [Story] label maps each task to its user story for traceability back to spec.md.
- Every task ID referenced in "depends on" notes must be completed first.
- Commit after each task or logical group, per the constitution's Conventional Commits convention (`feat(US-01): ...`, `test(US-01): ...`).
- Run `npm run build && npm run lint && npm run format:check && npm run test` after every task, per Principle IX — do not move to the next task on a failure.
