# Tasks: Create Customers from Identity Registrations (US-10)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/user-registered.md](contracts/user-registered.md)

Rules for every task: copy the shape of the named existing file instead of inventing a new pattern;
JSDoc on public classes/methods; no `any`. After each phase run the quality gate:
`npm run build`, `npm run lint`, `npm run format:check`, `npm run test`.

## Phase 1: Setup

- [X] T001 Add `identityGroupId` to `KafkaConfig` (env `KAFKA_IDENTITY_GROUP_ID`, default `ecommerce-orders-identity-consumer`), copying `inventoryGroupId`, in src/config/configuration.ts; add the variable to .env.example
- [X] T002 [P] Add a default-value case for `identityGroupId` in tests/unit/config/configuration.spec.ts

## Phase 2: Foundational (schema + domain, blocks all stories)

- [X] T003 Create migration src/infra/database/migrations/20261119120000-AddCustomerRegistration.ts exactly as in data-model.md "processed_events" + "Customer" tables (up and down), copying the style of 20261114120000-AddOrderOutcomes.ts
- [X] T004 [P] Add nullable `name` (varchar 100) and `email` (varchar 320) to src/infra/database/entities/customer.entity.ts; replace the "read-only reference row" JSDoc with "created from identity.user-registered (US-10)"
- [X] T005 [P] In src/infra/database/entities/processed-event.entity.ts: `orderId` nullable (`string | null`), add nullable `customerId` uuid, add enum values `CUSTOMER_CREATED` and `IGNORED_CUSTOMER_EXISTS`, update the CHECK and add `CHK_processed_events_order_or_customer` to match the migration
- [X] T006 In src/commands/inbound-event-ref.ts make `orderId` optional and add optional `customerId`; update `describeInboundEvent` to print `customerId=` when set; fix compile errors in src/repositories/processed-event.repository.ts (write `orderId ?? null`, `customerId ?? null`) and any other caller the build reports
- [X] T007 [P] Create src/domain/customer.ts: `Customer` with readonly `id`, `name: string | null`, `email`; static `register({ id, name, email })` that throws `CustomerValidationError` (same file) when id is not a UUID, email is empty after trim, or name is longer than 100; no NestJS imports
- [X] T008 [P] Unit tests for `Customer.register` (valid, null name, empty email, bad id, name 101 chars) in tests/unit/domain/customer.spec.ts

## Phase 3: User Story 1 — a registered customer can place orders (P1) 🎯 MVP

**Independent test**: publish a valid message → customer row with id = `customerId`; `POST /orders` for it → `201`.

- [X] T009 [P] [US1] Create src/dto/user-registered-message.dto.ts (class-validator, copy src/dto/stock-reserved-message.dto.ts): `eventId` UUID, `aggregateId` UUID, `occurredAt` string, `version` equals 1, `customerId` UUID, `email` non-empty string, `name` optional string max 100
- [X] T010 [US1] Create src/infra/kafka/user-registered-message.parser.ts copying src/infra/kafka/stock-message.parser.ts: export `USER_REGISTERED_TOPIC = 'identity.user-registered'`, `parseUserRegisteredMessage(topic, value)` returning `{ eventId, customerId, name: string | null, email }` (never returns `aggregateId`), throws `MalformedMessageError` with `eventId` when readable
- [X] T011 [P] [US1] Create src/commands/create-customer.command.ts: `CreateCustomerCommand { customerId, name, email, ref: InboundEventRef }`
- [X] T012 [US1] Add `createIfAbsent(customer: Customer, ref: InboundEventRef): Promise<{ created: boolean }>` to src/repositories/customer.repository.ts: one transaction — `INSERT ... ON CONFLICT ("id") DO NOTHING` into `customers`, `created = affected === 1`, then insert the `processed_events` row (`customerId`, `orderId` null, outcome `CUSTOMER_CREATED` or `IGNORED_CUSTOMER_EXISTS`); on unique violation of `processed_events` throw `EventAlreadyProcessedError` (use `isUniqueViolation`, as in processed-event.repository.ts); register `ProcessedEventEntity` in the module if needed
- [X] T013 [US1] Create src/services/create-customer.service.ts (`@CommandHandler(CreateCustomerCommand)`): `Customer.register(...)`, `createIfAbsent`, log `customer created` or `customer already exists (no-op)` with `describeInboundEvent`; publishes nothing
- [X] T014 [US1] Create src/infra/kafka/identity-events.consumer.ts copying src/infra/kafka/inventory-events.consumer.ts: group `identityGroupId`, `topics = [USER_REGISTERED_TOPIC]`, `process()` parses and dispatches `CreateCustomerCommand` with `ref = { eventId, topic, customerId }`, `EventAlreadyProcessedError` treated as success exactly like the inventory consumer, `describe` returns `{ eventId }`
- [X] T015 [US1] Register `IdentityEventsConsumer` and `CreateCustomerService` in src/app.module.ts; add the identity consumer to `inboundHandlers` in src/infra/dead-letter/dead-letter-retry.worker.ts (constructor parameter + array)
- [X] T016 [P] [US1] Unit tests for the parser (valid; `aggregateId` ≠ `customerId` → result uses `customerId`; missing name → null) in tests/unit/infra/user-registered-message.parser.spec.ts
- [X] T017 [P] [US1] Unit tests for the handler with a mocked repository (new customer → `createIfAbsent` called, no publish; invalid email → `CustomerValidationError`) in tests/unit/services/create-customer.service.spec.ts
- [X] T018 [P] [US1] Unit tests for the consumer (dispatches `CreateCustomerCommand` with `customerId`, never `aggregateId`; commits after dispatch) copying tests/unit/infra/inventory-events.consumer.spec.ts into tests/unit/infra/identity-events.consumer.spec.ts; update tests/unit/infra/dead-letter-retry.worker.spec.ts for the new constructor parameter
- [X] T019 [US1] Integration test (testcontainers Postgres, copy setup from tests/integration/order-repository.outcomes.integration.spec.ts): `createIfAbsent` creates the row with name/email and a `CUSTOMER_CREATED` processed event, in tests/integration/customer-repository.integration.spec.ts
- [X] T020 [US1] Component test (copy setup from tests/component/order-outcomes.component.spec.ts and tests/component/support/kafka-testing.ts): publish a valid message → customer with id `customerId` exists, none with id `aggregateId`; then `POST /orders` for it → `201`, in tests/component/customer-registration.component.spec.ts

## Phase 4: User Story 2 — repeats are harmless (P1)

**Independent test**: same message twice → one customer; new eventId for an existing customer → unchanged, no dead letter.

- [ ] T021 [P] [US2] Unit test: handler with `createIfAbsent` returning `{ created: false }` logs the no-op and does not throw, in tests/unit/services/create-customer.service.spec.ts
- [ ] T022 [US2] Integration tests in tests/integration/customer-repository.integration.spec.ts: existing id with other name/email → unchanged + `IGNORED_CUSTOMER_EXISTS`; same `eventId` twice → `EventAlreadyProcessedError`; two concurrent `createIfAbsent` for one id with different eventIds → one row, both resolve
- [ ] T023 [US2] Component tests in tests/component/customer-registration.component.spec.ts: redelivery of the same message → one customer, one processed event; new eventId for the same `customerId` with another name → customer unchanged, no row in `consumed_message_dead_letters`

## Phase 5: User Story 3 — reliable processing (P2)

**Independent test**: malformed message → dead letter at once, next valid message processed.

- [ ] T024 [P] [US3] Unit tests for the parser's malformed cases (bad JSON, non-object, missing eventId/customerId/email, non-UUID ids, empty email, version 2, name not a string, name 101 chars → `MalformedMessageError`) in tests/unit/infra/user-registered-message.parser.spec.ts
- [ ] T025 [P] [US3] Unit test: consumer dead-letters a malformed message and commits, and on a repository failure retries then dead-letters as retryable, copying the matching cases of tests/unit/infra/inventory-events.consumer.spec.ts into tests/unit/infra/identity-events.consumer.spec.ts
- [ ] T026 [US3] Component test in tests/component/customer-registration.component.spec.ts: publish `not json` and a message without `email`, then a valid one → two not-retryable rows in `consumed_message_dead_letters` (topic `identity.user-registered`) and the valid customer created
- [ ] T027 [P] [US3] Integration test: migration down then up keeps existing `customers` and payment/stock `processed_events` rows, copying tests/integration/order-outcomes-migration.integration.spec.ts into tests/integration/customer-registration-migration.integration.spec.ts

## Phase 6: User Story 4 — documentation (P3)

- [ ] T028 [P] [US4] Create docs/events/user-registered.md from contracts/user-registered.md, in the format of docs/events/stock-reserved.md, consistent with ecommerce-infra/docs/events.md
- [ ] T029 [P] [US4] Create docs/adr/0007-customers-from-identity-events.md (Context / Decision / Consequences, from research.md items 2, 4, 5) using docs/adr/template.md, and add it to docs/adr/README.md
- [ ] T030 [US4] Update README.md: events table `UserRegistered` → Implemented; Customers section — consumer implemented, `KAFKA_IDENTITY_GROUP_ID`, early order → `404`, client retries later; `npm run seed:customers` marked legacy (local development only)
- [ ] T031 [P] [US4] Update CLAUDE.md: replace "consumer not built yet" with the consumer path `src/infra/kafka/identity-events.consumer.ts` and group `KAFKA_IDENTITY_GROUP_ID`; add `KAFKA_IDENTITY_GROUP_ID` to the consumer env list

## Phase 7: Polish

- [ ] T032 Run `npm run build`, `npm run lint`, `npm run format:check`, `npm run test` and fix failures
- [ ] T033 Walk through quickstart.md steps 1–5 against local infra

## Dependencies

Setup → Foundational → US1 → US2, US3 (independent of each other) → US4 → Polish.
Within US1: T009 → T010 → T014; T011, T012 → T013 → T014 → T015 → T020.

## Parallel examples

- Phase 2: T004, T005, T007, T008 together after T003.
- US1: T009 and T011 together; T016, T017, T018 together after T015.
- US4: T028, T029, T031 together.

## Strategy

MVP = Phases 1–3 (customer created and order accepted). Then US2 and US3 add tests mostly (behaviour
already comes from T012/T014), US4 docs. Commit per phase: `feat(US-10): ...`, `test(US-10): ...`,
`docs(US-10): ...`.
