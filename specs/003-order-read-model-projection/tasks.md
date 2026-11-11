---

description: "Task list for US-05 Order Read Model Projection"
---

# Tasks: Order Read Model Projection (US-05)

**Input**: Design documents from `specs/003-order-read-model-projection/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10), data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED by the user's description and constitution Principles V/VI. These are:
- unit tests for the projection rules (including out-of-order and duplicate events);
- integration tests against a real MongoDB container;
- a component test with real Kafka, PostgreSQL and MongoDB containers.

Within each story, write the tests first and confirm they fail before implementing.

**Organization**: by the four user stories in spec.md:

- **US1** Lifecycle in the read model (P1)
- **US2** Late and out-of-order events (P1)
- **US3** Replays and duplicates change nothing (P2)
- **US4** Keep projecting past failures (P2)

**Quality gate (Constitution IX)**: after **every** task, run `npm run build && npm run lint &&
npm run format:check && npm run test`, and fix any failure before moving on. Commit per phase
with Conventional Commits scoped `US-05` (`feat(US-05): …`, `test(US-05): …`, `refactor(US-05): …`,
`docs(US-05): …`).

**Read/write separation (Principle II, FR-019/020)**: nothing under `src/read-model/` may import
from `src/domain/`, `src/infra/database/entities/`, `src/services/` or `src/repositories/`. The
only exceptions are `ConsumedMessageDeadLetterRepository` and the Kafka helpers, which are used by
the consumer in `src/infra/kafka/`, not by `src/read-model/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (setup, foundational and polish tasks have no label)

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Install dependencies: `npm install @nestjs/mongoose@^10.1.0 mongoose@^8` and `npm install -D @testcontainers/mongodb@10.28.0`. Commit both `package.json` and `package-lock.json`. Verify `npm ls @nestjs/mongoose mongoose @testcontainers/mongodb` shows no peer warnings.
- [X] T002 Extend `src/config/configuration.ts`:
  - Add `ReadModelConfig { mongoUri: string }` (`MONGO_URI`, default `mongodb://localhost:27017/orders_read`) and add `readModel` to `AppConfig`.
  - Add `projectionGroupId` to `KafkaConfig` (`KAFKA_PROJECTION_GROUP_ID`, default `ecommerce-orders-projection`).
  - JSDoc each field.
  - Update the JSDoc of `consumerEnabled` and the retry fields to say they apply to **both** consumers.
- [X] T003 [P] Append to `.env.example`, under a `# Read model (US-05)` comment: `MONGO_URI=mongodb://mongo_user:mongo_pass@localhost:27017/orders_read?authSource=admin` and `KAFKA_PROJECTION_GROUP_ID=ecommerce-orders-projection`. Add the same two lines to the local `.env` (git-ignored) so `start:dev` works.
- [X] T004 [P] In `jest.config.js`, add `'src/read-model/**/*.ts'`, `'!src/read-model/**/*.module.ts'` and `'!src/read-model/**/*.schema.ts'` to `collectCoverageFrom`, and a `'src/read-model/**/*.ts'` entry in `coverageThreshold` with 80 on all four metrics.

**Checkpoint**: `npm run build` and `npm run test` are green (no behaviour change yet).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared consumer helper (with US-04 kept unchanged), read-side types, the
schema and module, and message parsing.

**⚠️ CRITICAL**: no user-story work begins until this phase is complete.

### Tests first

- [X] T005 [P] Unit tests in `tests/unit/infra/consume-with-dead-letter.spec.ts` for the helper from T008, with mocked `deadLetters`, `commit`, `handle` and `parse`:
  - parse throws `MalformedMessageError` → `recordMalformed` (with `eventId`/`orderId` from the error), commit, `handle` never called;
  - `handle` succeeds → commit only;
  - `handle` fails once then succeeds → no dead letter, commit;
  - `handle` keeps failing → `recordRetriesExhausted(meta, lastError, maxAttempts)`, then commit;
  - `handle` keeps failing with an error for which `isFatal` returns true → **rethrows** after the retries, with no dead letter and no commit;
  - the dead-letter write throws → rethrows, no commit;
  - a non-`MalformedMessageError` thrown by `parse` → rethrows;
  - the retry log contains topic, partition, offset, `eventId`, `orderId` and `attempt n/max`.
- [X] T006 [P] Unit tests in `tests/unit/infra/order-event-message.parser.spec.ts` for `parseOrderEventMessage(topic, value)`:
  - valid placed, confirmed and cancelled payloads (copy the shapes from `docs/events/*.md`) map to the `OrderEvent` variants, with `occurredAt` as a `Date`, `orderId` taken from `aggregateId`, `reason` `null` when absent or `null`, and `""` kept;
  - each of these throws `MalformedMessageError` carrying any readable `eventId`/`aggregateId` as `orderId`:
    - invalid JSON, a `null` value, a JSON array;
    - missing `eventId`, non-UUID `aggregateId`, bad `occurredAt`, `version: 2`, missing `customerId`;
    - placed with `items: []`, `quantity: 0`, `quantity: 1.5`, `unitPrice: -1`, or missing `totalAmount`;
    - cancelled with `reason: 5`;
    - an unknown topic.

### Implementation

- [X] T007 Create `MalformedMessageError` (`message`, optional `eventId`, optional `orderId`) in `src/infra/kafka/malformed-message.error.ts`. Change `MalformedPaymentMessageError` in `src/infra/kafka/payment-message.parser.ts` to `extends MalformedMessageError`, keeping its constructor signature and `name`. All US-04 tests must still pass.
- [X] T008 Create `consumeWithDeadLetter<T>(payload: EachMessagePayload, options)` in `src/infra/kafka/consume-with-dead-letter.ts`. The options are `{ parse(topic, value): T; describe(parsed: T): { eventId?: string; orderId?: string }; handle(parsed: T): Promise<unknown>; isFatal?(error): boolean; deadLetters: ConsumedMessageDeadLetterRepository; retry: { maxAttempts; initialMs; maxMs }; commit(): Promise<void>; logger: Logger }`.
  - Move the parse → `retryWithBackoff` (`isRetryable = !(e instanceof MalformedMessageError)`, `heartbeat` from the payload) → dead-letter → commit logic out of `PaymentEventsConsumer.handleMessage`.
  - Add the fatal branch: on `RetriesExhaustedError` whose `lastError` satisfies `isFatal`, log an error and rethrow `lastError` without dead-lettering or committing.
  - JSDoc the flow.
  - Makes T005 pass.
- [X] T009 Refactor `PaymentEventsConsumer.handleMessage` in `src/infra/kafka/payment-events.consumer.ts` to delegate to `consumeWithDeadLetter`, with `parse = parsePaymentMessage`, `handle` dispatching `ReactToPaymentOutcomeCommand`, and no `isFatal`. Keep the constructor, the public API and the log text compatible. `tests/unit/infra/payment-events.consumer.spec.ts` and the US-04 integration and component suites MUST pass **unchanged**.
- [X] T010 [P] Create the read-side types in `src/read-model/`. None of these files may import from `src/domain/`:
  - `order-view-status.enum.ts`: `OrderViewStatus` with `PENDING`/`CONFIRMED`/`CANCELLED`.
  - `order-view.ts`: `OrderItemView`, `OrderView` (all fields per data-model.md, `null` for unknown) and `StoredOrderView { view; revision }`.
  - `order-event.ts`: the `OrderEvent` discriminated union (`type: 'OrderPlaced' | 'OrderConfirmed' | 'OrderCancelled'`) with the fields from data-model.md.
  - `errors.ts`: `OrderViewConcurrencyError(orderId)` and `ReadModelUnavailableError(cause)`, each JSDoc'd with its retry semantics.
- [X] T011 [P] Unit test `tests/unit/read-model/order-view-status.spec.ts`: `Object.values(OrderViewStatus)` equals `Object.values(OrderStatus)`. This test is the only place the two are compared (Principle II).
- [X] T012 [P] Create the message DTOs in `src/read-model/messages/`:
  - `order-placed-message.dto.ts` with a nested `OrderPlacedItemMessageDto`, validated with `@ValidateNested({ each: true }) @Type(() => OrderPlacedItemMessageDto) @IsArray() @ArrayMinSize(1)`;
  - `order-confirmed-message.dto.ts`;
  - `order-cancelled-message.dto.ts`.

  Validators per research R9. JSDoc every field, and state in the class doc that these are read-side DTOs, separate from the write-side event classes.
- [X] T013 Create `parseOrderEventMessage(topic, value: Buffer | null): OrderEvent` and the topic constant list `ORDER_EVENT_TOPICS` in `src/infra/kafka/order-event-message.parser.ts`. Use `ORDER_PLACED_TOPIC`, `ORDER_CONFIRMED_TOPIC` and `ORDER_CANCELLED_TOPIC` from `order-events.producer.ts`, with JSON → `plainToInstance` → `validateSync` → map to `OrderEvent`. Throw `MalformedMessageError` with readable ids. Makes T006 pass.
- [X] T014 Create the Mongoose schema in `src/read-model/order-view.schema.ts`: `OrderViewDocument` with `@Schema({ collection: 'order_views', versionKey: false, timestamps: false })`, `_id: String`, every field from data-model.md (nullable fields `default: null`), and an embedded `OrderItemViewSchema` with `{ _id: false }`.
- [X] T015 Create `ReadModelModule` in `src/read-model/read-model.module.ts`. It uses `MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (c) => ({ uri: c.get('readModel').mongoUri, lazyConnection: true, bufferCommands: false, serverSelectionTimeoutMS: 5000 }) })` plus `MongooseModule.forFeature([{ name: OrderViewDocument.name, schema }])`. Providers and exports are filled in by later tasks. Import `ReadModelModule` in `src/app.module.ts`. Confirm that `npm run start:dev` still boots **with MongoDB stopped** (lazy connection, FR-021), and record the result in the PR notes.

**Checkpoint**: all US-04 tests pass unchanged, the helper and parser tests pass, and the app boots with Mongo up or down.

---

## Phase 3: User Story 1 — Every new order appears and follows its lifecycle (Priority: P1) 🎯 MVP

**Goal**: placed → a `PENDING` view with items, subtotals, total and `placedAt`. Confirmed → `CONFIRMED` + `confirmedAt`. Cancelled → `CANCELLED` + `cancelledAt` + reason. All of this happens in normal arrival order, persisted in `order_views` by a running consumer.

**Independent Test**: component test: place an order through REST → the view is `PENDING` with items and total; confirm through REST → the view is `CONFIRMED` with `confirmedAt`.

### Tests (write first)

- [X] T016 [P] [US1] Unit tests in `tests/unit/read-model/order-view.projector.spec.ts` (in-order cases):
  - placed on `null` gives a `PENDING` view with every field per data-model.md, item `subtotal` rounded (e.g. `3 × 19.99 = 59.97`, `1 × 0.1 + …` rounding), `placedAt = updatedAt = occurredAt`, `appliedEventIds = [eventId]`, `statusEventId = null`;
  - confirmed on that view gives `CONFIRMED`, `confirmedAt`, `statusEventId`, `updatedAt = max`, and ids sorted;
  - cancelled with a reason gives `CANCELLED`, `cancelledAt` and the reason;
  - cancelled with `reason: ''` stores `''`;
  - cancelled with `reason: null` gives `cancellationReason: null`;
  - the result is `{ kind: 'changed', warnings: [] }`.
- [X] T017 [P] [US1] Unit tests in `tests/unit/read-model/order-projection.service.spec.ts` (mock `OrderViewRepository`):
  - no stored view → `insert(view)`;
  - a stored view at revision 3 → `replace(view, 3)`;
  - projector warnings are logged with `logger.warn`;
  - repository errors propagate.
- [X] T018 [P] [US1] Integration test in `tests/integration/order-view.repository.integration.spec.ts`. Use `MongoDBContainer('mongo:7')` with `MongooseModule.forRoot(container.getConnectionString(), { directConnection: true })` + `forFeature`. Cover:
  - `insert` then `findById` round-trips every field, including `null`s, `Date`s and embedded items with no `_id` on items;
  - a second `insert` of the same id throws `OrderViewConcurrencyError`;
  - `replace(view, 1)` → revision 2;
  - `replace(view, 1)` again (stale) throws `OrderViewConcurrencyError`;
  - `findById` of an unknown id → `null`;
  - the stored document has no `__v`, `createdAt` or `updatedAt` added by Mongoose (other than the projector's `updatedAt`).
- [X] T019 [US1] Component test in `tests/component/order-projection.component.spec.ts`:
  - real `PostgreSqlContainer`, `KafkaContainer('confluentinc/cp-kafka:7.6.1')` and `MongoDBContainer('mongo:7')`;
  - create the three `orders.*` topics plus the payment topics;
  - build modules like `tests/component/react-to-payment-outcome.component.spec.ts`, plus `ReadModelModule`, with `MONGO_URI` set to the container URI (with `directConnection=true`) and a unique `KAFKA_PROJECTION_GROUP_ID`;
  - `POST /orders` → poll Mongo (≤ 30s) for a `PENDING` view with the correct `customerId`, items with subtotals, `totalAmount` and `placedAt`;
  - `POST /orders/:id/confirm` → poll for `CONFIRMED` with `confirmedAt`, and `appliedEventIds.length === 2`;
  - restore every env var in `afterAll`.

### Implementation

- [X] T020 [US1] Implement `projectOrderEvent(current: OrderView | null, event: OrderEvent): ProjectionResult` in `src/read-model/order-view.projector.ts` for the **in-order** paths (data-model.md rules: create on placed; terminal on `PENDING`; sorted `appliedEventIds`; `updatedAt` = max). Write it so later stories only add branches. Pure, no I/O. JSDoc the rules table. Makes T016 pass.
- [X] T021 [US1] Implement `OrderViewRepository` in `src/read-model/order-view.repository.ts`, injecting `@InjectModel(OrderViewDocument.name)`:
  - `findById(orderId): Promise<StoredOrderView | null>` using `lean()`, mapping the document to `OrderView`;
  - `insert(view)`: `create({ _id: orderId, ...view, revision: 1 })`, translating error code `11000` into `OrderViewConcurrencyError`;
  - `replace(view, expectedRevision)`: `replaceOne({ _id, revision: expected }, { ...view, revision: expected + 1 })`, where `matchedCount === 0` throws `OrderViewConcurrencyError`.

  Register and export it in `ReadModelModule`. Makes T018 pass.
- [X] T022 [US1] Implement `OrderProjectionService.project(event: OrderEvent): Promise<'applied' | 'duplicate'>` in `src/read-model/order-projection.service.ts`: `findById` → `projectOrderEvent` → `insert` or `replace(view, revision)`, log warnings, and return the outcome. Orchestration only. Register and export it in `ReadModelModule`. Makes T017 pass.
- [X] T023 [US1] Implement `OrderProjectionConsumer` in `src/infra/kafka/order-projection.consumer.ts`, mirroring `PaymentEventsConsumer`:
  - `kafka.consumer({ groupId: projectionGroupId })` created in the constructor;
  - `OnApplicationBootstrap` starts in the background when `consumerEnabled`: subscribe to `ORDER_EVENT_TOPICS` with `fromBeginning: true`, then `run({ autoCommit: false, eachMessage })`;
  - `handleMessage(payload)` delegates to `consumeWithDeadLetter`, with `parse = parseOrderEventMessage`, `describe = { eventId, orderId }` and `handle = (e) => projectionService.project(e)`;
  - `OnApplicationShutdown` disconnects;
  - JSDoc it.

  Register it in `ReadModelModule` (it needs `KAFKA_CLIENT`, `ConfigService`, `OrderProjectionService` and `ConsumedMessageDeadLetterRepository`; import `TypeOrmModule.forFeature([ConsumedMessageDeadLetterEntity])` and provide the repository there, or export it from the app module). Makes T019 pass.

**Checkpoint**: MVP. New orders and their lifecycle appear in `order_views`.

---

## Phase 4: User Story 2 — Late and out-of-order events (Priority: P1)

**Goal**: whatever the arrival order, the final view is the same. A terminal status is never overwritten by a late placed event. A late placed event fills in items, total and `placedAt`. Conflicting terminals are resolved by "earliest wins".

**Independent Test**: confirmed→placed gives the same document as placed→confirmed (unit test and real Mongo).

### Tests (write first)

- [X] T024 [P] [US2] Extend `tests/unit/read-model/order-view.projector.spec.ts`:
  - confirmed on `null` → `CONFIRMED`, `customerId` set, `items`/`totalAmount`/`placedAt` `null`;
  - cancelled on `null` similarly, with the reason;
  - placed on a `CONFIRMED` (or `CANCELLED`) view → items, total and `placedAt` filled in, status unchanged, `confirmedAt` kept;
  - **permutation property**: for every permutation of {placed, confirmed} and {placed, cancelled}, folding the events gives deep-equal views;
  - **conflict**: confirmed(t1) + cancelled(t2>t1) in both orders → `CONFIRMED`/`confirmedAt=t1`/`cancelledAt=null`/`cancellationReason=null`, with one warning returned;
  - **tie**: equal `occurredAt` → the smaller `eventId` wins, in both orders.
- [X] T025 [US2] Integration test in `tests/integration/order-projection.integration.spec.ts` (`MongoDBContainer`, real `OrderViewRepository` + `OrderProjectionService`):
  - apply placed→confirmed for order A and confirmed→placed for an identical order B (same events, different `orderId`);
  - compare the stored documents, ignoring `_id`/`orderId`;
  - also cover cancelled-first with a reason.

### Implementation

- [X] T026 [US2] Extend `projectOrderEvent` in `src/read-model/order-view.projector.ts`:
  - create a view from a terminal event when `current` is `null`;
  - a placed event on an existing view fills in data without touching `status`, `statusEventId` or the terminal timestamps;
  - terminal-vs-terminal resolution by `(occurredAt, eventId)`, clearing the loser's timestamp and reason and returning a warning naming both event ids.

  Makes T024–T025 pass.

**Checkpoint**: views are correct for any arrival order.

---

## Phase 5: User Story 3 — Replays and duplicates change nothing (Priority: P2)

**Goal**: an event already in `appliedEventIds` is a no-op. A full rebuild into an empty collection reproduces identical documents. The first start backfills existing orders.

**Independent Test**: re-apply every event (no change, no write); drop and replay (deep-equal to the snapshot, including `updatedAt` and `revision`).

### Tests (write first)

- [X] T027 [P] [US3] Extend `tests/unit/read-model/order-view.projector.spec.ts`. Re-applying any already-applied event (placed, confirmed, cancelled, and the losing terminal in a conflict) returns `{ kind: 'unchanged' }`.
- [X] T028 [P] [US3] Extend `tests/unit/read-model/order-projection.service.spec.ts`. An `unchanged` projection performs **no** repository write and returns `'duplicate'`.
- [X] T029 [US3] Extend `tests/integration/order-projection.integration.spec.ts`:
  - **replay over existing**: re-project all events of 3 orders → every call returns `'duplicate'` and the documents are deep-equal to the snapshot;
  - **rebuild**: `deleteMany({})`, then re-project the same events in a different order → deep-equal to the snapshot, including `updatedAt`, `appliedEventIds` and `revision`.
- [X] T030 [US3] Extend `tests/component/order-projection.component.spec.ts` with a **backfill** case:
  - before starting the app module, produce a valid `orders.order-placed` message directly to Kafka (simulating an order placed before this story);
  - after init, poll until its view exists as `PENDING`;
  - produce the **same** message again and wait 2s → the document is unchanged (deep-equal).

### Implementation

- [X] T031 [US3] In `src/read-model/order-view.projector.ts`, add the dedupe guard as the first rule: if `current?.appliedEventIds.includes(event.eventId)`, return `{ kind: 'unchanged' }`. In `src/read-model/order-projection.service.ts`, skip the write on `unchanged` and return `'duplicate'`, with a debug log. Makes T027–T030 pass.

**Checkpoint**: replay and rebuild are safe (FR-015, SC-002).

---

## Phase 6: User Story 4 — Keep projecting past failures (Priority: P2)

**Goal**: a malformed event is dead-lettered immediately. A write conflict is retried. A persistent unexpected error is dead-lettered after the retries. A **MongoDB outage** is never dead-lettered: the offset is not committed, and the event is redelivered.

**Independent Test**: `not json` on `orders.order-placed` gives one `MALFORMED` dead letter, and the next order is still projected. Mongo unavailable gives no dead letter and no commit.

### Tests (write first)

- [ ] T032 [P] [US4] Unit tests in `tests/unit/infra/order-projection.consumer.spec.ts` (mocked kafkajs `Consumer`, `OrderProjectionService`, dead-letter repository, and config with `maxAttempts: 3`, backoff 1/2 ms):
  - valid → `project` then `commitOffsets(offset + 1)`;
  - `not json` → `recordMalformed` with attempts 1, then commit, with no `project` call;
  - `project` throws `OrderViewConcurrencyError` once then succeeds → commit, no dead letter;
  - `project` always throws `Error('boom')` → `recordRetriesExhausted` (attempts 3), then commit;
  - `project` always throws `ReadModelUnavailableError` → `handleMessage` rejects, with **no** dead letter and **no** commit;
  - the group id comes from `projectionGroupId`, not `groupId`.
- [ ] T033 [P] [US4] Extend `tests/integration/order-view.repository.integration.spec.ts` with an **outage mapping** case: build a repository against a stopped `MongoDBContainer` (or an unreachable URI with `serverSelectionTimeoutMS: 500`); `findById` and `insert` reject with `ReadModelUnavailableError`.
- [ ] T034 [US4] Extend `tests/component/order-projection.component.spec.ts`:
  - produce `not json` to `orders.order-placed`, then place a real order;
  - assert one `consumed_message_dead_letters` row with `failureType = 'MALFORMED'` and `topic = 'orders.order-placed'`;
  - assert the real order's view appears.

### Implementation

- [ ] T035 [US4] In `src/read-model/order-view.repository.ts`, wrap every Mongo call. Translate connectivity failures into `ReadModelUnavailableError(cause)`: `MongoServerSelectionError`, `MongoNetworkError`, `MongoNotConnectedError`, and Mongoose's "buffering"/"not connected" errors (check `error.name` against a constant list, with no `any`). Pass other errors through. Makes T033 pass.
- [ ] T036 [US4] In `src/infra/kafka/order-projection.consumer.ts`, pass `isFatal: (e) => e instanceof ReadModelUnavailableError` to `consumeWithDeadLetter`, and log the outage at error level with topic, partition and offset. Makes T032 and T034 pass.

**Checkpoint**: all four stories work, and US-04 is unchanged.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T037 [P] Create `docs/read-model.md`:
  - purpose and link to ADR 0001;
  - the document shape (link `specs/003-order-read-model-projection/contracts/order-view-document.md`, with the field table inline);
  - the projection rules (in-order, out-of-order, conflicting terminals, duplicates);
  - determinism (`updatedAt`, sorted ids, `revision`);
  - failure handling (malformed, retries, outage);
  - **backfill and rebuild procedure** (reset `ecommerce-orders-projection` to earliest, and optionally drop `order_views` first);
  - **limits**: Kafka's 7-day retention, and orders whose `OrderPlaced` is in `order_dead_letters`;
  - configuration (`MONGO_URI`, `KAFKA_PROJECTION_GROUP_ID`, shared retry settings).
- [ ] T038 [P] Create `docs/adr/0004-read-model-projection-consistency.md`, following `docs/adr/template.md`. Context: three independent topics and redelivery. Decision: order-independent merge, per-document `appliedEventIds`, deterministic timestamps, optimistic `revision`, outage redelivered vs poison dead-lettered. Consequences: replay-safe rebuilds; the event history bounds backfill. Add it to the index in `docs/adr/README.md`.
- [ ] T039 [P] Update the "Consumers" sections of `docs/events/order-placed.md`, `order-confirmed.md` and `order-cancelled.md`: the projection (group `ecommerce-orders-projection`) is now **built**, not planned, with a link to `docs/read-model.md`.
- [ ] T040 [P] Update `README.md`:
  - the read path becomes "read model built (US-05), GraphQL planned (US-06/07)";
  - the `orders.*` consumed row becomes **Built**;
  - add `MONGO_URI` and `KAFKA_PROJECTION_GROUP_ID` to the env table, and note that `KAFKA_CONSUMER_ENABLED` and `PAYMENT_CONSUMER_*` apply to both consumers;
  - the tests section mentions the MongoDB container;
  - add a "Read model" link to `docs/read-model.md`.
- [ ] T041 [P] Update `CLAUDE.md`:
  - the stack moves the read side from planned to built (projection), with GraphQL still planned;
  - add the `src/read-model/` rule (no imports from `src/domain`, `src/infra/database/entities`, `src/services` or `src/repositories`);
  - add the projection consumer group and the outage-vs-poison rule;
  - add the new env vars.
- [ ] T042 [P] Update `src/README.md`: add a `read-model/` row to the folder table, add the projection consumer and helper to the `infra/kafka/` row, replace "Read model (planned, not yet built)" with a "Where an order event goes (US-05)" flow line, and update the events table's consumer column.
- [ ] T043 Run the full quality gate and `npm run test:cov`. Confirm the 80% thresholds on `src/domain`, `src/services` and `src/read-model`, and that the US-04 suites are unchanged and green.
- [ ] T044 Validate live with `specs/003-order-read-model-projection/quickstart.md`:
  - §2: backfill count equals the Postgres order count (within retention), and a new order shows `PENDING` then `CONFIRMED`/`CANCELLED` within 5s each;
  - §3: snapshot, reset the group to earliest, replay, and diff (no differences);
  - §4: the malformed and Mongo-outage scenarios.

  Record the results for the PR description.

---

## Dependencies & Execution Order

- **Setup (T001–T004)**: T002 depends on nothing; T003 and T004 can run in parallel.
- **Foundational (T005–T015)**: needs Setup. T007 → T008 → T009 (the refactor needs the helper). T010–T012 [P]. T013 needs T010 and T012. T014 needs T010. T015 needs T014.
- **US1 (T016–T023)**: needs Foundational. **MVP.**
- **US2 (T024–T026)**: needs T020 (the projector exists). Repository and service are unchanged.
- **US3 (T027–T031)**: needs T020 and T022. Independent of US2, although the permutation tests read best after it.
- **US4 (T032–T036)**: needs T021 and T023. T035 and T036 can follow US1 directly.
- **Polish (T037–T044)**: after the stories it documents. T037–T042 are all [P].

```text
Setup ──▶ Foundational ──▶ US1 (MVP) ──┬──▶ US2
                                       ├──▶ US3
                                       └──▶ US4 ──▶ Polish
```

Within each story: tests first and failing, then implementation, then the quality gate, then a commit.

## Parallel Examples

- **Setup**: T003 + T004.
- **Foundational**: T005 + T006 (tests) together with T010 + T011 + T012. Then T007 → T008 → T009, and T013, T014 → T015.
- **US1**: T016 + T017 + T018 together. Then T020 → T021 → T022 → T023 (T019 goes green last).
- **US2 / US3 / US4** can proceed in parallel after US1. They touch different branches of the same projector file, so merge carefully (projector edits are sequential across US2 and US3).
- **Polish**: T037–T042 together.

## Implementation Strategy

1. **MVP = Setup + Foundational + US1**: new orders and their lifecycle appear in `order_views`. Demo with quickstart §2.
2. **US2**: correctness for any arrival order.
3. **US3**: replay, rebuild and backfill safety (the "identical documents" acceptance criterion).
4. **US4**: poison-message and outage resilience.
5. **Polish**: docs, ADR 0004, coverage, and the live validation.
