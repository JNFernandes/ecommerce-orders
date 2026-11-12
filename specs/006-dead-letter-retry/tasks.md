---
description: 'Task list for US-08 Dead-Letter Retry'
---

# Tasks: Dead-Letter Retry (US-08)

**Input**: Design documents from `specs/006-dead-letter-retry/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10), data-model.md,
contracts/dead-letter-retry-behaviour.md, quickstart.md

**Tests**: REQUIRED by the user's description and constitution Principles V/VI:

- unit tests for the backoff and retry decisions with fake time;
- integration tests for claiming against a PostgreSQL container;
- a component test with real Kafka and PostgreSQL in which publishing fails first and succeeds
  later.

Write the tests first and confirm they fail before implementing.

**Organization**: by the four user stories in spec.md:

- **US1** Unpublished events are published once the broker is back (P1)
- **US2** Failed inbound messages are processed again (P1)
- **US3** Hopeless failures stop being retried (P2)
- **US4** Several instances retry safely together (P2)

**Quality gate (Constitution IX)**: after every task, run `npm run build && npm run lint &&
npm run format:check && npm run test`. **Commit only when the gate exits 0**: chain the commit with
`&&`, never `;`. Conventional Commits scoped `US-08`.

**Reuse rule**:

- republish only through `OrderEventsProducer`;
- re-handle inbound messages only through the consumers' `process()` (the same parse and handler as
  live consumption);
- do not duplicate parsing, handlers or the projection;
- the worker never calls `consumeWithDeadLetter` and never commits Kafka offsets.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (setup, foundational and polish tasks have no label)

---

## Phase 1: Setup

- [x] T001 Add `DeadLetterConfig { enabled; intervalMs; batchSize; baseDelayMs; maxDelayMs; maxRetries }` to `src/config/configuration.ts` (`deadLetter` in `AppConfig`), with JSDoc. Read `DEAD_LETTER_RETRY_ENABLED` (on unless `"false"`), `DEAD_LETTER_RETRY_INTERVAL_MS` (30000), `DEAD_LETTER_BATCH_SIZE` (20), `DEAD_LETTER_BASE_DELAY_MS` (5000), `DEAD_LETTER_MAX_DELAY_MS` (600000) and `DEAD_LETTER_MAX_RETRIES` (8). Append them, with defaults, under a `# Dead-letter retry (US-08)` comment in `.env.example` and the local `.env`. Update the existing unit-test `KafkaConfig`/`AppConfig` fixtures only if they stop type-checking.
- [x] T002 [P] Call `app.enableShutdownHooks()` in `configureApp` in `src/app.setup.ts` (research R8), with a JSDoc line explaining that SIGTERM/SIGINT must run `onModuleDestroy`/`onApplicationShutdown` (consumers, worker).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the schema, the pure retry policy, and claiming in the existing repositories.

### Tests first

- [x] T003 [P] Unit tests in `tests/unit/infra/retry-policy.spec.ts` (fake `now`, settings `base 5000, max 600000, maxRetries 8`):
  - `deadLetterDelay(1..8)` = 5000, 10000, 20000, 40000, 80000, 160000, 320000, 600000 (the cap); with `maxDelayMs 30000`, retry 4 is capped at 30000;
  - `decideRetry` success → `RESOLVED`, `resolvedAt = now`, `lastAttemptAt = now`, `lastError = null`, `retryCount + 1`;
  - permanent → `EXHAUSTED`, `retryCount + 1`, with the error;
  - transient at `retryCount 0` → `PENDING_RETRY`, `retryCount 1`, `nextRetryAt = now + 5000`;
  - transient at `retryCount 6` → `PENDING_RETRY`, `7`, `+320000`;
  - transient at `retryCount 7` → `EXHAUSTED`, `8`;
  - `nextRetryAt` is unchanged on `RESOLVED`/`EXHAUSTED`.
- [x] T004 [P] Integration test `tests/integration/dead-letter.repository.integration.spec.ts` (`PostgreSqlContainer`; run the real migrations with `migrationsRun: true` and `synchronize: false`, so the migration and backfill are exercised):
  - **backfill**: insert rows before running the new migration. Use a DataSource that runs migrations one at a time (`dataSource.runMigrations({ transaction: 'each' })`) after inserting rows between the base and the new migration, or insert via SQL into the pre-US-08 schema and then run the US-08 migration. Then: an outbound row is `PENDING_RETRY` with `nextRetryAt ≤ now`; a `MALFORMED` inbound row is `EXHAUSTED`; a `RETRIES_EXHAUSTED` inbound row is `PENDING_RETRY`;
  - **claim**: `processNextDue` returns `false` when nothing is due; picks only `PENDING_RETRY` rows with `nextRetryAt ≤ now`, oldest `nextRetryAt` first; applies the handler's `RetryUpdate` (verify the columns); a handler that throws leaves the row unchanged (rollback) and still due.

  Cover both repositories.

### Implementation

- [x] T005 [P] Create `DeadLetterStatus` (`PENDING_RETRY`, `RESOLVED`, `EXHAUSTED`) in `src/infra/database/entities/dead-letter-status.enum.ts`, with JSDoc for each state.
- [x] T006 Add to `src/infra/database/entities/order-dead-letter.entity.ts` and `src/infra/database/entities/consumed-message-dead-letter.entity.ts`:
  - `status` (`enum DeadLetterStatus`, `enumName: 'dead_letter_status_enum'`, default `PENDING_RETRY`);
  - `nextRetryAt` (timestamptz, default `() => 'now()'`);
  - `lastAttemptAt`, `lastError` and `resolvedAt` (nullable);
  - on the consumed table, also `retryCount` (int, default 0).

  JSDoc each column, and state that `attempts` counts in-consumer attempts while `retryCount` counts worker attempts.

- [x] T007 Create the migration `src/infra/database/migrations/20261112120000-AddDeadLetterRetryBookkeeping.ts` (class `AddDeadLetterRetryBookkeeping20261112120000`), per data-model.md:
  - create the enum;
  - add the columns to both tables (plus `retryCount` on consumed);
  - `UPDATE consumed_message_dead_letters SET status='EXHAUSTED' WHERE "failureType"='MALFORMED'`;
  - add the partial indexes `IDX_order_dead_letters_due` and `IDX_consumed_dead_letters_due` (`("nextRetryAt","createdAt") WHERE status='PENDING_RETRY'`);
  - a full `down()`.

  Run `npm run migration:run` and `npm run migration:revert` and `npm run migration:run` against ecommerce-infra.

- [x] T008 Create `src/infra/dead-letter/retry-policy.ts` with `RetrySettings`, `AttemptResult`, `RetryUpdate`, `deadLetterDelay(retryCount, settings)` and `decideRetry(row: { retryCount }, result, now, settings): RetryUpdate`, per research R3. Pure, with JSDoc. Makes T003 pass.
- [x] T009 Add `processNextDue(handler: (row) => Promise<RetryUpdate>): Promise<boolean>` to `src/repositories/order-dead-letter.repository.ts` and `src/repositories/consumed-message-dead-letter.repository.ts`. Use `DataSource.transaction`:
  - query `SELECT * FROM <table> WHERE status = $1 AND "nextRetryAt" <= now() ORDER BY "nextRetryAt", "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED` through the query builder with `.setLock('pessimistic_write').setOnLocked('skip_locked')`, or a raw query;
  - return `false` when there is no row;
  - otherwise `await handler(row)` and apply the update with `manager.update(Entity, { id }, update)`.

  Inject `DataSource`. JSDoc the locking contract. Also change `recordMalformed` in `src/repositories/consumed-message-dead-letter.repository.ts` to insert `status: DeadLetterStatus.EXHAUSTED`, and extend `tests/unit/infra/consume-with-dead-letter.spec.ts` or a repository unit test accordingly. Makes T004 pass.

**Checkpoint**: the schema, policy and claiming are ready, and the migration applies and reverts cleanly.

---

## Phase 3: User Story 1 — Unpublished events are published once the broker is back (Priority: P1) 🎯 MVP

**Goal**: the worker runs every interval without blocking startup or overlapping. It republishes due outbound rows through `OrderEventsProducer` with the same `eventId`, keyed by `aggregateId`, then marks them `RESOLVED`, or reschedules them on failure.

**Independent Test**: component: make `producer.send` fail once on `POST /orders`, so a `PENDING_RETRY` row appears; restore it; within a few intervals the row is `RESOLVED` and an observer receives `OrderPlaced` with the original `eventId`.

### Tests (write first)

- [X] T010 [P] [US1] Unit test for `OrderEventsProducer.republish` in `tests/unit/infra/order-events.producer.spec.ts` (mock `Producer`): it sends `{ topic, messages: [{ key: payload.aggregateId, value: JSON.stringify(payload) }] }` and propagates send errors.
- [X] T011 [P] [US1] Unit tests in `tests/unit/infra/dead-letter-retry.worker.spec.ts` (Jest fake timers, mocked repositories, producer and consumers, config `intervalMs 1000, batchSize 3`):
  - `onApplicationBootstrap` returns immediately and runs no cycle before `intervalMs`;
  - after `intervalMs`, one cycle calls `outbound.processNextDue` until it returns `false` or 3 times;
  - a slow cycle (handler promise held open) is not overlapped by a second cycle even after several intervals;
  - the next cycle is scheduled only after the previous one finishes;
  - outbound handler: a valid row calls `producer.republish(row.topic, row.payload)` and returns `decideRetry(..., success)`;
  - a send error gives a transient result, a topic outside the three `orders.*` topics gives a permanent result, and a payload missing a string `eventId`/`aggregateId` gives a permanent result;
  - `enabled: false` → no cycles ever;
  - `onModuleDestroy` clears the timer and awaits the in-flight cycle, and no further `processNextDue` calls happen afterwards.
- [X] T012 [US1] Component test `tests/component/dead-letter-retry.component.spec.ts`:
  - real `PostgreSqlContainer` + `KafkaContainer`, topics via `createTopicsWhenReady`;
  - write-path providers plus `DeadLetterRetryWorker`, with `DEAD_LETTER_RETRY_INTERVAL_MS=200`, `DEAD_LETTER_BASE_DELAY_MS=100` and `KAFKA_CONSUMER_ENABLED=false`;
  - an observer consumer on `orders.order-placed`;
  - stub `producer.send` to reject once, `POST /orders`, then assert the order is in Postgres, one `order_dead_letters` row exists with `status PENDING_RETRY`, and no event has been observed yet;
  - restore `send` and poll (≤ 15s) until the row is `RESOLVED` with `resolvedAt`;
  - assert the observer received exactly one `OrderPlaced` for that order whose `eventId` equals the row's `eventId`.

  Restore the env vars in `afterAll`.

### Implementation

- [X] T013 [US1] Add `republish(topic: string, payload: Record<string, unknown>): Promise<void>` to `src/infra/kafka/order-events.producer.ts`, with the key taken from `payload.aggregateId` (string). Add JSDoc ("same event, same eventId; at-least-once"). Makes T010 pass.
- [X] T014 [US1] Create `DeadLetterRetryWorker` in `src/infra/dead-letter/dead-letter-retry.worker.ts`, implementing `OnApplicationBootstrap` and `OnModuleDestroy`:
  - inject `ConfigService`, `OrderDeadLetterRepository`, `ConsumedMessageDeadLetterRepository`, `OrderEventsProducer`, `PaymentEventsConsumer` and `OrderProjectionConsumer`;
  - a self-rescheduling `setTimeout` (`unref`) with `stopping` / `inFlight` handling (research R1);
  - `runCycle()`: loop `outbound.processNextDue(this.retryOutbound)` up to `batchSize`, stopping early when it returns `false` or `stopping` is set;
  - `retryOutbound(row)`: validate the topic against `ORDER_*_TOPIC` and the payload ids (permanent failure if invalid), call `producer.republish`, and return `decideRetry(row, result, new Date(), settings)`;
  - log a cycle summary at debug level and a warning on each failure (row id, topic, eventId, retryCount, error);
  - a cycle-level `try/catch` that logs DB errors and keeps scheduling.

  Register it in `src/app.module.ts`. JSDoc. Makes T011 and T012 pass.

**Checkpoint**: MVP. Events that failed to publish go out automatically after an outage.

---

## Phase 4: User Story 2 — Failed inbound messages are processed again (Priority: P1)

**Goal**: due inbound rows are routed by topic to the consumer that owns it and re-handled through the same `process()` as live consumption. Success, including a duplicate, gives `RESOLVED`; malformed gives `EXHAUSTED`; any other failure is rescheduled. No new dead letters and no offset commits.

**Independent Test**: insert an inbound row whose raw value is a `payments.payment-processed` message for an existing `PENDING` order. The worker confirms the order once and resolves the row. Re-inserting the same message as a new row resolves it as a duplicate, with no second confirmation.

### Tests (write first)

- [X] T015 [P] [US2] Extend `tests/unit/infra/payment-events.consumer.spec.ts` and `tests/unit/infra/order-projection.consumer.spec.ts`:
  - `topics` lists the consumer's topics;
  - `process(topic, value)` parses and handles once, with **no** retry, no dead-letter call and no `commitOffsets`;
  - a malformed value makes `process` reject with `MalformedMessageError`;
  - a handler error propagates.

  The existing `handleMessage` tests must stay green unchanged.

- [X] T016 [P] [US2] Extend `tests/unit/infra/dead-letter-retry.worker.spec.ts`:
  - a `payments.*` row calls `paymentConsumer.process(row.topic, Buffer.from(row.rawValue))` and an `orders.*` row calls `projectionConsumer.process`;
  - success → `RESOLVED`; `MalformedMessageError` → `EXHAUSTED` (permanent); another error → transient;
  - an unknown topic → permanent;
  - `rawValue: null` → permanent;
  - each cycle drains inbound rows too, up to `batchSize`.
- [X] T017 [US2] Extend `tests/component/dead-letter-retry.component.spec.ts`:
  - add `ReactToPaymentOutcomeService`, `ProcessedEventRepository`, `PaymentEventsConsumer` and the projection pieces needed by the worker's dependencies. Construct `OrderProjectionConsumer` with `ReadModelModule` and a `MongoDBContainer`, or provide a minimal mock via `overrideProvider` if Mongo is not needed for the payment case. Record the choice in a comment;
  - place an order via REST (the event publishes normally), then insert a `consumed_message_dead_letters` row (`topic payments.payment-processed`, `rawValue` = a valid message for that order, `failureType RETRIES_EXHAUSTED`, `status PENDING_RETRY`) and poll until the order is `CONFIRMED` and the row `RESOLVED`;
  - insert the identical message again as a new row → it becomes `RESOLVED` with the order still confirmed once (one `processed_events` row).

### Implementation

- [X] T018 [US2] In `src/infra/kafka/payment-events.consumer.ts` and `src/infra/kafka/order-projection.consumer.ts`, add a `readonly topics` and `async process(topic: string, value: Buffer | null): Promise<void>` (parse + handle, exactly the parse and handle steps used today), and make `handleMessage` pass them to `consumeWithDeadLetter` (`parse`/`handle` built from `process`'s pieces). Pure refactor of live consumption. Makes T015 pass.
- [X] T019 [US2] Add `retryInbound(row)` to `src/infra/dead-letter/dead-letter-retry.worker.ts`:
  - route by `row.topic` to the consumer whose `topics` include it (unknown topic → permanent);
  - `rawValue === null` → permanent;
  - `await consumer.process(row.topic, Buffer.from(row.rawValue, 'utf8'))`;
  - map `MalformedMessageError` → permanent, other errors → transient, success → success;
  - `decideRetry`.

  Extend `runCycle()` to drain `inbound.processNextDue(this.retryInbound)` up to `batchSize` after the outbound rows. Makes T016 and T017 pass.

**Checkpoint**: both stores are retried.

---

## Phase 5: User Story 3 — Hopeless failures stop being retried (Priority: P2)

**Goal**: growing delays (5s, 10s, 20s, …, capped), then `EXHAUSTED` after `maxRetries`, never claimed again, with an error log carrying full context.

**Independent Test**: an always-failing row with `maxRetries 3` is attempted exactly 3 times with growing gaps and ends `EXHAUSTED`. The error log names the row id, kind, topic, eventId, orderId, retryCount and last error.

### Tests (write first)

- [X] T020 [P] [US3] Extend `tests/unit/infra/dead-letter-retry.worker.spec.ts` (fake timers and an injected clock):
  - a row whose handler always fails is attempted on successive due times with gaps of 5s, 10s and 20s (assert the `nextRetryAt` values passed to the update), and the third failure (with `maxRetries 3`) yields `EXHAUSTED`;
  - exhaustion logs **one** `logger.error` containing the row id, `outbound`/`inbound`, topic, eventId, orderId (inbound), `retryCount` and `lastError`;
  - `RESOLVED`/`EXHAUSTED` rows are never passed to handlers (the repository contract; covered by T004, re-asserted here through the mock returning `false`).
- [X] T021 [US3] Extend `tests/component/dead-letter-retry.component.spec.ts`: an inbound row for a random `orderId` with `DEAD_LETTER_MAX_RETRIES=3` and `DEAD_LETTER_BASE_DELAY_MS=100` → poll until `EXHAUSTED`. Assert `retryCount = 3`, `lastError` mentions the order not being found, and `resolvedAt` is null.

### Implementation

- [X] T022 [US3] In `src/infra/dead-letter/dead-letter-retry.worker.ts`, after `decideRetry` returns `EXHAUSTED`, log `logger.error` with full context (research R3/FR-011). Ensure the injected clock (`now: () => Date`, default `() => new Date()`) is used everywhere for fake-time testing. Makes T020 and T021 pass (the policy already exhausts).

**Checkpoint**: retries are bounded and visible.

---

## Phase 6: User Story 4 — Several instances retry safely together (Priority: P2)

**Goal**: concurrent workers never process the same row, and a crashed worker's row is immediately due again.

**Independent Test**: two concurrent `processNextDue` calls whose handlers both wait on a barrier receive different rows. A third concurrent call finds nothing. After the handlers resolve, each row was updated exactly once.

### Tests (write first)

- [X] T023 [US4] Extend `tests/integration/dead-letter.repository.integration.spec.ts`:
  - **concurrency**: seed 2 due rows; start `processNextDue` A and B concurrently, each handler recording its row id and awaiting a shared barrier promise; while both are held, a third call C returns `false`; release the barrier; assert A ≠ B, both rows updated once (`retryCount` exactly 1), for both repositories;
  - **crash release**: a handler that throws → the row is immediately claimable again by a new call;
  - **no double processing in a cycle**: after a transient update (`nextRetryAt` in the future), an immediate second `processNextDue` returns `false`.
- [X] T024 [P] [US4] Extend `tests/component/dead-letter-retry.component.spec.ts`: start a **second** `DeadLetterRetryWorker` instance (resolve a second instance from the module, or construct it with the same dependencies) on 4 due outbound rows. Assert each row ends `RESOLVED` with `retryCount` 1, and the observer sees each `eventId` exactly once.

### Implementation

- [X] T025 [US4] Verify T009's `processNextDue` satisfies T023/T024 (`FOR UPDATE SKIP LOCKED`, lock held during the handler, rollback on throw). Fix it in the repositories if not. No new code expected.

**Checkpoint**: multi-instance safety is proven.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T026 [P] Create `docs/dead-letter-retry.md`:
  - the two stores and what lands in each;
  - the status state machine;
  - `retryCount` vs `attempts`, and the `RETRIES_EXHAUSTED` failure type vs the `EXHAUSTED` status;
  - the default schedule table;
  - the settings;
  - per-row transaction claiming and multi-instance behaviour;
  - at-least-once delivery and the unchanged `eventId`;
  - inbound routing by topic;
  - how to inspect the stores (SQL examples), and the out-of-scope list (no admin API, purge or replay).
- [X] T027 [P] Create `docs/adr/0005-dead-letter-retry.md` (template: Context / Decision / Consequences): per-row transaction with `SKIP LOCKED` and no lease; the self-rescheduling timer without `@nestjs/schedule`; reuse of the producer and consumer `process()`; deterministic backoff; at-least-once delivery; the remaining gap (no outbox). Add it to `docs/adr/README.md`.
- [X] T028 [P] Update `README.md`: the "Payment outcome consumer" and read-model sections say dead letters are retried automatically; add the six `DEAD_LETTER_*` variables to the env table; link `docs/dead-letter-retry.md`.
- [X] T029 [P] Update `CLAUDE.md`: dead-letter rules (statuses; retry via the worker; never create new dead letters from a retry; republish through `OrderEventsProducer.republish`; inbound through the consumers' `process()`) and the new env vars.
- [X] T030 [P] Update the docs that call retry future work: `docs/read-model.md` ("Replaying them is US-08"), `docs/events/payment-processed.md` ("Replaying them is US-08"), `docs/events/order-placed.md`/`order-confirmed.md`/`order-cancelled.md` (the "Failure handling" section: rows are now retried), and `src/README.md` (add `infra/dead-letter/` to the folder table).
- [X] T031 Run the full quality gate and `npm run test:cov`, and confirm thresholds. Run `npm run schema:generate && git diff --exit-code docs/schema.gql` (unchanged).
- [ ] T032 Live validation per `specs/006-dead-letter-retry/quickstart.md`, on a **separate port** with `DEAD_LETTER_RETRY_INTERVAL_MS=5000`:
  1. run the migration and check that the existing `MALFORMED` rows are `EXHAUSTED` and the `RETRIES_EXHAUSTED` row resolves on the first cycle;
  2. **broker outage**: stop `ecommerce-kafka-1`, `POST /orders`, see the `PENDING_RETRY` row with a growing `retryCount`, start Kafka, see `RESOLVED` with the same `eventId` published, and the order confirmed and projected.

  Stop the instance by PID and kill any orphaned child processes. Record the results.

---

## Dependencies & Execution Order

- **Setup (T001–T002)**: T002 [P].
- **Foundational (T003–T009)**: T003 and T004 (tests) and T005 [P]; then T005 → T006 → T007; T008 [P] with T006/T007; T009 after T006.
- **US1 (T010–T014)**: needs Foundational. **MVP.**
- **US2 (T015–T019)**: needs US1's worker (T014). T015 and T018 (consumer refactor) can start right after Foundational.
- **US3 (T020–T022)**: needs T014. Best after US2, so inbound exhaustion is covered.
- **US4 (T023–T025)**: needs T009. T023 can run right after Foundational; T024 needs T014.
- **Polish (T026–T032)**: after all stories. T026–T030 [P].

```text
Setup ──▶ Foundational ──▶ US1 (MVP) ──▶ US2 ──▶ US3
                    └──────────────▶ US4 (T023 early; T024 after US1)
                                                     └──▶ Polish
```

## Parallel Examples

- **Foundational**: T003 + T004 + T005, then T008 alongside T006/T007.
- **US1**: T010 + T011 together.
- **US2**: T015 + T016 together; T018 (consumer refactor) alongside US1's T014.
- **Polish**: T026–T030 together.

## Implementation Strategy

1. **MVP = Setup + Foundational + US1**: events that failed to publish are republished automatically.
2. **US2**: failed payment outcomes and projection updates are re-handled.
3. **US3**: bounded retries with a visible `EXHAUSTED` state and logs.
4. **US4**: proven multi-instance safety.
5. **Polish**: docs, ADR 0005, gate, and the live outage check.
