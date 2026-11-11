---

description: "Task list for US-04 React to Payment Outcome"
---

# Tasks: React to Payment Outcome (US-04)

**Input**: Design documents from `specs/002-react-to-payment-outcome/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10), data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED. The spec's acceptance criteria and constitution Principles V/VI require
unit, integration (real PostgreSQL) and component (real Kafka + PostgreSQL) tests. Within each
story, write the tests first and confirm they fail before implementing.

**Organization**: Tasks are grouped by the four user stories in spec.md:

- **US1** Confirm on payment processed (P1)
- **US2** Cancel on payment failed (P1)
- **US3** Process each message once in effect (P2)
- **US4** Keep consuming past bad messages (P2)

**Quality gate (Constitution IX)**: after **every** task, run `npm run build && npm run lint &&
npm run format:check && npm run test`, and fix any failure before moving on. Commit with
Conventional Commits scoped `US-04` (e.g. `feat(US-04): add payment reaction policy`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md (setup, foundational and polish tasks have no label)
- Paths are relative to the repository root (single project: `src/`, `tests/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration and the schema every story writes to.

- [ ] T001 Extend `KafkaConfig` and its loader in `src/config/configuration.ts` with `consumerEnabled` (`KAFKA_CONSUMER_ENABLED`, default `true`; only the string `"false"` disables it), `maxAttempts` (`PAYMENT_CONSUMER_MAX_ATTEMPTS`, default 5), `backoffInitialMs` (`PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, default 1000) and `backoffMaxMs` (`PAYMENT_CONSUMER_BACKOFF_MAX_MS`, default 30000). Keep `groupId` from `KAFKA_GROUP_ID`. Add JSDoc for each field. Add the four new variables with their defaults to `.env.example`.
- [ ] T002 [P] Add a nullable `cancellationReason` column (`type: 'text', nullable: true`, TS type `string | null`) to `src/infra/database/entities/order.entity.ts`.
- [ ] T003 [P] Create `ProcessedEventEntity` in `src/infra/database/entities/processed-event.entity.ts` for table `processed_events`: `eventId` uuid primary column, `topic` varchar, `orderId` uuid (indexed `IDX_processed_events_orderId`), `paymentId` uuid, `outcome` enum `ProcessedEventOutcome` (`CONFIRMED`, `CANCELLED`, `IGNORED_ALREADY_CONFIRMED`, `IGNORED_ALREADY_CANCELLED`, `IGNORED_CONFLICT`, exported from the same file, DB enum name `processed_event_outcome_enum`), and `processedAt` timestamptz `CreateDateColumn`. JSDoc per data-model.md.
- [ ] T004 [P] Create `ConsumedMessageDeadLetterEntity` in `src/infra/database/entities/consumed-message-dead-letter.entity.ts` for table `consumed_message_dead_letters`. Columns, per data-model.md: `id` uuid PK, `topic` varchar, `partition` int, `offset` varchar, `messageKey` text null, `rawValue` text null, `eventId` uuid null (indexed `IDX_consumed_dead_letters_eventId`), `orderId` uuid null, `failureType` varchar (`MALFORMED` or `RETRIES_EXHAUSTED`, as an exported string-literal union or enum), `error` text, `attempts` int, and `createdAt` timestamptz `CreateDateColumn`.
- [ ] T005 Create the migration `src/infra/database/migrations/20261111120000-AddPaymentOutcomeConsumerSchema.ts` (class `AddPaymentOutcomeConsumerSchema20261111120000`) that adds `orders."cancellationReason" text NULL`, creates `processed_event_outcome_enum`, `processed_events` (PK `PK_processed_events` on `eventId`, plus the index) and `consumed_message_dead_letters` (PK, plus the index), mirroring T002–T004 exactly. `down()` drops everything in reverse order. Depends on T002–T004.
- [ ] T006 Register `ProcessedEventEntity` and `ConsumedMessageDeadLetterEntity` in `TypeOrmModule.forFeature([...])` in `src/app.module.ts`.

**Checkpoint**: `npm run build` passes. `npm run migration:run` against ecommerce-infra applies cleanly, and `migration:revert` reverts it.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Domain rule, command shapes, transactional persistence and the message parser that both P1 stories need.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

### Tests for the foundation (write first, confirm they fail)

- [ ] T007 [P] Unit tests for the policy in `tests/unit/domain/payment-reaction.policy.spec.ts`, covering all 6 cells of the data-model.md table, e.g. "should return CONFIRM for a PENDING order when payment is PROCESSED" and "should return CONFLICT for a CANCELLED order when payment is PROCESSED".
- [ ] T008 [P] Unit tests in `tests/unit/infra/payment-message.parser.spec.ts`. Valid processed and failed payloads parse into DTOs. A failed payload with missing or `null` `reason` normalises to `''`. Each of these throws `MalformedPaymentMessageError`: invalid JSON, `null` value, missing `eventId`, non-UUID `orderId`, missing `aggregateId`, `version: 2`, and `reason: 123`. Unknown extra fields are ignored. The error carries any `eventId` and `orderId` it could read.

### Implementation

- [ ] T009 [P] Create `PaymentOutcome` enum (`PROCESSED`, `FAILED`) in `src/domain/payment-outcome.enum.ts`, with JSDoc.
- [ ] T010 Create `PaymentReaction` enum (`CONFIRM`, `CANCEL`, `ALREADY_CONFIRMED`, `ALREADY_CANCELLED`, `CONFLICT`) and the pure function `decidePaymentReaction(status: OrderStatus, outcome: PaymentOutcome): PaymentReaction` in `src/domain/payment-reaction.policy.ts`. Exhaustive `switch`, no I/O, JSDoc explaining each cell. Makes T007 pass. Depends on T009.
- [ ] T011 [P] Create the `InboundEventRef` interface (`eventId`, `topic`, `orderId`, `paymentId`, all `string`, with JSDoc stating that `paymentId` comes from `aggregateId` and is never an order id) in `src/commands/inbound-event-ref.ts`.
- [ ] T012 [P] Create `PaymentProcessedMessageDto` in `src/dto/payment-processed-message.dto.ts` and `PaymentFailedMessageDto` in `src/dto/payment-failed-message.dto.ts`. Validators per research R7: `@IsUUID()` on `eventId`, `orderId` and `aggregateId`; `@Equals(1)` on `version`; `@IsOptional() @IsString()` on `reason` (failed only). Other contract fields are optional and unvalidated. JSDoc each field, stating that `aggregateId` is the payment id.
- [ ] T013 Create `MalformedPaymentMessageError` (with optional `eventId?`, `orderId?`) and `parsePaymentMessage(topic: string, rawValue: Buffer | null): ParsedPaymentMessage` in `src/infra/kafka/payment-message.parser.ts`. It runs `JSON.parse`, then `plainToInstance` + `validateSync` on the DTO for the topic, and returns `{ outcome: PaymentOutcome, inboundEvent: InboundEventRef, reason?: string }`. On any failure it throws `MalformedPaymentMessageError`, with `eventId`/`orderId` filled in when they are valid UUID strings. Export the topic constants `PAYMENT_PROCESSED_TOPIC = 'payments.payment-processed'` and `PAYMENT_FAILED_TOPIC = 'payments.payment-failed'`. Makes T008 pass. Depends on T009, T011, T012.
- [ ] T014 Create `OrderStatusChangedConcurrentlyError` in `src/repositories/errors/order-status-changed-concurrently.error.ts` and `EventAlreadyProcessedError` + `OrderNotFoundForPaymentError` in `src/services/errors/payment-outcome.errors.ts`. Each error is a named class extending `Error`, with JSDoc stating whether it is retryable.
- [ ] T015 Create `ProcessedEventRepository` in `src/repositories/processed-event.repository.ts`. `exists(eventId): Promise<boolean>`. `recordOutcome(ref: InboundEventRef, outcome: ProcessedEventOutcome): Promise<void>`, which inserts and translates PostgreSQL error code `23505` into `EventAlreadyProcessedError`. Register it in `src/app.module.ts` providers. Depends on T003, T014.
- [ ] T016 Extend `OrderRepository` in `src/repositories/order.repository.ts`:
  - Add `applyInboundStatusChange(order: Order, inbound: InboundEventRef, outcome: ProcessedEventOutcome): Promise<void>`. It runs inside `DataSource.transaction`, issues the conditional update `UPDATE orders SET status, "updatedAt" WHERE id = :id AND status = 'PENDING'` (throwing `OrderStatusChangedConcurrentlyError` when `affected === 0`), then inserts the `processed_events` row through the same `EntityManager` (translating `23505` into `EventAlreadyProcessedError`).
  - Inject `DataSource` via the constructor.
  - Leave `updateStatus` unchanged (FR-018).
  - `cancellationReason` mapping is added in T034 (US2), once the aggregate has the field (T032).

  Depends on T003, T014.

**Checkpoint**: policy and parser unit tests pass, and the build is green.

---

## Phase 3: User Story 1 — Confirm on payment processed (Priority: P1) 🎯 MVP

**Goal**: A valid `payments.payment-processed` message for a PENDING order confirms it through the existing write flow and publishes exactly one `OrderConfirmed`. CONFIRMED is a silent no-op; CANCELLED is a no-op with a warning. The order is resolved only by `orderId`.

**Independent Test**: Place an order, publish a payment-processed message for it to Kafka, and assert the status is `CONFIRMED` and exactly one `orders.order-confirmed` message is observed. REST confirm and cancel tests still pass unchanged.

### Tests for User Story 1 (write first)

- [ ] T017 [P] [US1] Unit tests in `tests/unit/services/react-to-payment-outcome.service.spec.ts` (mocked `CommandBus`, `OrderRepository`, `ProcessedEventRepository`):
  - PENDING + PROCESSED dispatches `ConfirmOrderCommand(orderId, inboundEvent)`.
  - CONFIRMED + PROCESSED records `IGNORED_ALREADY_CONFIRMED` and dispatches nothing.
  - CANCELLED + PROCESSED records `IGNORED_CONFLICT`, logs a warning containing `orderId`, `paymentId` and `eventId`, and dispatches nothing.
  - Unknown order throws `OrderNotFoundForPaymentError`.
  - When `aggregateId` (paymentId) equals an existing order id but `orderId` does not, `findById` is called only with `orderId`.
- [ ] T018 [P] [US1] Extend `tests/unit/services/confirm-order.service.spec.ts`. With `inboundEvent`, the service calls `orderRepository.applyInboundStatusChange(order, ref, CONFIRMED)` (not `updateStatus`), then publishes. A publish failure still goes to `orderDeadLetterRepository.recordFailure`. `OrderStatusChangedConcurrentlyError` propagates and nothing is published. Keep all existing REST-path tests unchanged.

- [ ] T019 [P] [US1] Unit tests in `tests/unit/infra/payment-events.consumer.spec.ts` (happy path only for this story; mocked kafkajs `Consumer` and `CommandBus`). `handleMessage` for a valid processed message dispatches `ReactToPaymentOutcomeCommand` and then calls `commitOffsets` with `offset + 1`. If dispatch throws, `commitOffsets` is **not** called and the error propagates. The `aggregateId` is never passed as an order id.
- [ ] T020 [US1] Integration test in `tests/integration/react-to-payment-outcome.integration.spec.ts`: a real PostgreSQL testcontainer, `synchronize: true`, all entities registered, the Kafka producer overridden with a mock, and a mocked `Consumer` for `commitOffsets`. Call `PaymentEventsConsumer.handleMessage` directly with a payment-processed `EachMessagePayload` for:
  - (a) a PENDING order: the order becomes CONFIRMED, a `processed_events` row exists with outcome `CONFIRMED`, `publishOrderConfirmed` is called once, and the offset is committed.
  - (b) a CANCELLED order: unchanged, outcome `IGNORED_CONFLICT`.
  - (c) a CONFIRMED order: unchanged, outcome `IGNORED_ALREADY_CONFIRMED`.
  - (d) a race: change the order to CANCELLED directly in the DB between load and save (stub `findById` to return a stale PENDING aggregate). `applyInboundStatusChange` throws `OrderStatusChangedConcurrentlyError` and the order stays CANCELLED.
- [ ] T021 [US1] Component test in `tests/component/react-to-payment-outcome.component.spec.ts`. Real PostgreSQL and `KafkaContainer('confluentinc/cp-kafka:7.6.1')`. Pre-create topics `payments.payment-processed`, `payments.payment-failed`, `orders.order-confirmed` and `orders.order-cancelled` with an admin client. Use the full module set of `AppModule`, built explicitly like the existing component specs, plus `ProcessedEventRepository`, `ConsumedMessageDeadLetterRepository`, `ReactToPaymentOutcomeService` and `PaymentEventsConsumer`. Set `KAFKA_GROUP_ID` to a unique value and the backoff env to `10`/`50` ms. Run an observer consumer on `orders.order-confirmed`. Then: place an order with `POST /orders`, produce a payment-processed message with a random `aggregateId` and the new `orderId`, poll the DB (≤ 10s) until the status is `CONFIRMED`, and assert exactly one observed `OrderConfirmed` for that `aggregateId`.

### Implementation for User Story 1

- [ ] T022 [US1] Change `ConfirmOrderCommand` in `src/commands/confirm-order.command.ts` to `constructor(public readonly orderId: string, public readonly inboundEvent?: InboundEventRef)`, and update its JSDoc.
- [ ] T023 [US1] Extend `ConfirmOrderService.execute` in `src/services/confirm-order.service.ts`. After `order.confirm()`, call `orderRepository.applyInboundStatusChange(order, command.inboundEvent, ProcessedEventOutcome.CONFIRMED)` when `command.inboundEvent` is set, and the existing `updateStatus` otherwise. The publish and dead-letter block is unchanged. Makes T018 pass.
- [ ] T024 [US1] Create `ReactToPaymentOutcomeCommand(outcome: PaymentOutcome, inboundEvent: InboundEventRef, reason?: string)` in `src/commands/react-to-payment-outcome.command.ts`.
- [ ] T025 [US1] Create `ReactToPaymentOutcomeService` (`@CommandHandler(ReactToPaymentOutcomeCommand)`) in `src/services/react-to-payment-outcome.service.ts`. It loads the order with `orderRepository.findById(inboundEvent.orderId)` and throws `OrderNotFoundForPaymentError` when missing. It calls `decidePaymentReaction(order.status, outcome)`:
  - `CONFIRM`: `commandBus.execute(new ConfirmOrderCommand(orderId, inboundEvent))`.
  - `ALREADY_CONFIRMED`: `processedEventRepository.recordOutcome(ref, IGNORED_ALREADY_CONFIRMED)` and log at debug.
  - `CONFLICT`: `recordOutcome(ref, IGNORED_CONFLICT)` and log a warning with `orderId`, `paymentId` and `eventId`.

  Leave `CANCEL` and `ALREADY_CANCELLED` for T029. Return the `ProcessedEventOutcome`. Register it in `src/app.module.ts` providers. Makes the US1 cases of T017 pass.
- [ ] T026 [US1] Create `PaymentEventsConsumer` in `src/infra/kafka/payment-events.consumer.ts`, implementing `OnApplicationBootstrap` and `OnApplicationShutdown`:
  - Bootstrap returns immediately when `consumerEnabled` is false. Otherwise it starts **without awaiting** (`void this.start().catch(log)`): create `kafka.consumer({ groupId })` from `KAFKA_CLIENT`, subscribe to both payment topics with `fromBeginning: true`, then `run({ autoCommit: false, eachMessage: (p) => this.handleMessage(p) })`.
  - Public `handleMessage(payload: EachMessagePayload)`: `parsePaymentMessage(topic, message.value)`, then `commandBus.execute(new ReactToPaymentOutcomeCommand(...))`, then `commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }])`. In this story, errors propagate (no commit). US4 adds retry and dead-lettering.
  - Shutdown disconnects the consumer.
  - JSDoc on the class and on `handleMessage`.
  - Register it in `src/app.module.ts` providers.

  Makes T019–T021 pass.

**Checkpoint**: US1 is fully functional. A payment-processed message confirms a PENDING order end to end. This is the MVP.

---

## Phase 4: User Story 2 — Cancel on payment failed (Priority: P1)

**Goal**: A valid `payments.payment-failed` message cancels a PENDING order through the existing cancel write flow, stores `reason` as `cancellationReason`, and publishes exactly one `OrderCancelled` carrying `reason`. CANCELLED is a silent no-op; CONFIRMED is a no-op with a warning.

**Independent Test**: Place an order, publish a payment-failed message with a reason, and assert the status is `CANCELLED`, `cancellationReason` equals the reason, and exactly one `orders.order-cancelled` message carries the same `reason`. REST cancel still emits a payload with no `reason` key.

### Tests for User Story 2 (write first)

- [ ] T027 [P] [US2] Extend `tests/unit/domain/order.aggregate.spec.ts`: `cancel('reason')` sets `cancellationReason` and the `OrderCancelled` event has `reason === 'reason'`. `cancel()` leaves `cancellationReason === null`, and `JSON.stringify(event)` has no `reason` key. `reconstitute` without the new argument gives `cancellationReason === null`. The existing tests stay unchanged.
- [ ] T028 [P] [US2] Extend `tests/unit/services/cancel-order.service.spec.ts`. With `{ reason, inboundEvent }`, the service calls `cancel(reason)` and `applyInboundStatusChange(order, ref, CANCELLED)`, publishes an event with `reason`, and still dead-letters on publish failure. Without options, the existing `updateStatus` path and payload are unchanged.
- [ ] T029 [P] [US2] Extend `tests/unit/services/react-to-payment-outcome.service.spec.ts`:
  - PENDING + FAILED dispatches `CancelOrderCommand(orderId, { reason, inboundEvent })`.
  - CANCELLED + FAILED records `IGNORED_ALREADY_CANCELLED`.
  - CONFIRMED + FAILED records `IGNORED_CONFLICT` and logs a warning.
- [ ] T030 [US2] Extend `tests/integration/react-to-payment-outcome.integration.spec.ts` with payment-failed cases. PENDING: the order becomes CANCELLED with `cancellationReason` set, the outcome is `CANCELLED`, and `publishOrderCancelled` receives an event with `reason`. CONFIRMED: unchanged, outcome `IGNORED_CONFLICT`. CANCELLED: unchanged, outcome `IGNORED_ALREADY_CANCELLED`.
- [ ] T031 [US2] Extend `tests/component/react-to-payment-outcome.component.spec.ts` with an observer on `orders.order-cancelled`. Place an order, produce a payment-failed message with `reason`, poll until `CANCELLED`, and assert `cancellationReason` in the DB and exactly one observed `OrderCancelled` whose `reason` matches.

### Implementation for User Story 2

- [ ] T032 [US2] Extend the `Order` aggregate in `src/domain/order.aggregate.ts`:
  - Add `public cancellationReason: string | null` to the private constructor (after `updatedAt`, default `null`).
  - `cancel(reason?: string)` sets `this.cancellationReason = reason ?? null` before raising the event.
  - `reconstitute(..., cancellationReason: string | null = null)`.
  - Update `Order.place` to pass `null`, and update the JSDoc.
- [ ] T033 [US2] Extend `OrderCancelled` in `src/domain/events/order-cancelled.event.ts` with `public readonly reason?: string`. `from(order)` sets it only when `order.cancellationReason !== null`, so `JSON.stringify` omits it otherwise. JSDoc it as optional and additive, with `version` still 1. Makes T027 pass.
- [ ] T034 [US2] In `src/repositories/order.repository.ts`, make `applyInboundStatusChange` also set `"cancellationReason" = order.cancellationReason` in its conditional update, and make `findById` pass `entity.cancellationReason` to `Order.reconstitute`.
- [ ] T035 [US2] Change `CancelOrderCommand` in `src/commands/cancel-order.command.ts` to `constructor(orderId: string, options?: { reason?: string; inboundEvent?: InboundEventRef })` (expose `reason` and `inboundEvent` as readonly). Then extend `CancelOrderService.execute` in `src/services/cancel-order.service.ts`: call `order.cancel(command.reason)`, use `applyInboundStatusChange(..., CANCELLED)` when `inboundEvent` is set, and `updateStatus` otherwise. The publish and dead-letter block is unchanged. Makes T028 pass.
- [ ] T036 [US2] Add the `CANCEL` and `ALREADY_CANCELLED` branches to `ReactToPaymentOutcomeService` in `src/services/react-to-payment-outcome.service.ts`. `CANCEL` dispatches `new CancelOrderCommand(orderId, { reason: command.reason ?? '', inboundEvent })`. `ALREADY_CANCELLED` records `IGNORED_ALREADY_CANCELLED`. Makes T029–T031 pass.

**Checkpoint**: US1 and US2 both work independently, and the full saga (Orders ↔ Payments) completes.

---

## Phase 5: User Story 3 — Process each message once in effect (Priority: P2)

**Goal**: Redelivering the same `eventId` changes nothing and publishes nothing, including after a no-op, and it is acknowledged.

**Independent Test**: Produce the same payment message twice. The order changes once, one event is observed, there is one `processed_events` row, and both offsets are committed.

### Tests for User Story 3 (write first)

- [ ] T037 [P] [US3] Extend `tests/unit/services/react-to-payment-outcome.service.spec.ts`. When `processedEventRepository.exists(eventId)` is true, the service returns without loading the order or dispatching. `EventAlreadyProcessedError` from the dispatched command or from `recordOutcome` is caught and treated as already processed (no rethrow).
- [ ] T038 [P] [US3] Extend `tests/integration/react-to-payment-outcome.integration.spec.ts`:
  - The same processed message handled twice gives one `processed_events` row, one publish call, and two commits.
  - The same message after a no-op is still recognised.
  - Calling `applyInboundStatusChange` with an `eventId` that already exists in `processed_events` (while the order is PENDING) throws `EventAlreadyProcessedError`, and the order stays PENDING (transaction rolled back).
- [ ] T039 [US3] Extend `tests/component/react-to-payment-outcome.component.spec.ts`. After the US1 confirmation, re-produce the **identical** message, wait 3s, and assert that the status is still `CONFIRMED`, exactly one `OrderConfirmed` is observed, and `processed_events` has one row for that `eventId`.

### Implementation for User Story 3

- [ ] T040 [US3] Add the dedupe fast path and the duplicate handling to `ReactToPaymentOutcomeService.execute` in `src/services/react-to-payment-outcome.service.ts`. First, `if (await processedEventRepository.exists(eventId))`, log at debug and return `ALREADY_PROCESSED`. Wrap the dispatch and `recordOutcome` calls so that `EventAlreadyProcessedError` is logged and returned as `ALREADY_PROCESSED`. Add `ALREADY_PROCESSED` to the service's result type (not to the DB enum). Makes T037–T039 pass.

**Checkpoint**: replays are safe. SC-002 and SC-003 hold.

---

## Phase 6: User Story 4 — Keep consuming past bad messages (Priority: P2)

**Goal**: Malformed messages are dead-lettered immediately. Retryable failures back off exponentially and are then dead-lettered. In both cases the offset is committed after the dead-letter row is saved, and the next message is processed. If the dead-letter write fails, nothing is committed.

**Independent Test**: Produce `not json`, then a valid message. One `MALFORMED` dead letter (attempts 1) is written and the valid one is processed. Produce a message for a random `orderId`: after `maxAttempts` attempts there is one `RETRIES_EXHAUSTED` dead letter and later messages still flow.

### Tests for User Story 4 (write first)

- [ ] T041 [P] [US4] Unit tests in `tests/unit/infra/retry-with-backoff.spec.ts` (Jest fake timers). Delays follow `min(initial × 2^(n-1), max)` ±20% jitter (inject the random source for determinism). The helper returns on the first success. It rethrows the last error after `maxAttempts`. A non-retryable error (predicate) is thrown immediately with no delay. `heartbeat` is invoked at least every 3s during a long wait. `onRetry` is called with the attempt number and the error.
- [ ] T042 [P] [US4] Extend `tests/unit/infra/payment-events.consumer.spec.ts`:
  - Malformed: `recordMalformed` is called with `attempts 1`, then commit, with no retry and no dispatch.
  - Dispatch failing `maxAttempts` times: `recordRetriesExhausted` is called with the attempt count, then commit.
  - Dispatch failing once and then succeeding: no dead letter, then commit.
  - Dead-letter repository throwing: no commit, and the error propagates.
  - The log on each retry includes topic, partition, offset, `eventId`, `orderId` and attempt.
- [ ] T043 [US4] Extend `tests/integration/react-to-payment-outcome.integration.spec.ts` (backoff 1/5 ms, `maxAttempts` 3):
  - An invalid JSON value gives a `consumed_message_dead_letters` row with `failureType MALFORMED`, `rawValue` verbatim, `attempts 1`, and the offset committed.
  - An unknown `orderId` gives a `RETRIES_EXHAUSTED` row with `attempts 3` and `orderId`/`eventId` set.
  - A message whose `aggregateId` is an existing **order** id while `orderId` is random leaves that order untouched and is dead-lettered as unknown.
- [ ] T044 [US4] Extend `tests/component/react-to-payment-outcome.component.spec.ts`. Produce `not json` followed by a valid payment-processed message for a new order. Assert one `MALFORMED` dead letter and that the valid order still becomes `CONFIRMED`.

### Implementation for User Story 4

- [ ] T045 [P] [US4] Create `retryWithBackoff<T>(fn, opts: { maxAttempts; initialMs; maxMs; isRetryable(e): boolean; heartbeat?(): Promise<void>; onRetry?(attempt, error, delayMs): void; random?(): number; sleep?(ms): Promise<void> }): Promise<T>` in `src/infra/kafka/retry-with-backoff.ts`. Implement it per research R6, splitting the sleep into ≤3s chunks with `heartbeat` between them. JSDoc. Makes T041 pass.
- [ ] T046 [P] [US4] Create `ConsumedMessageDeadLetterRepository` in `src/repositories/consumed-message-dead-letter.repository.ts` with `recordMalformed(meta, error)` and `recordRetriesExhausted(meta, error, attempts)`. `meta` holds `topic`, `partition`, `offset`, `messageKey`, `rawValue`, `eventId?` and `orderId?`. `rawValue` is stored as `message.value?.toString('utf8') ?? null`. Register it in `src/app.module.ts` providers.
- [ ] T047 [US4] Wire failure handling into `PaymentEventsConsumer.handleMessage` in `src/infra/kafka/payment-events.consumer.ts`:
  - Parse. On `MalformedPaymentMessageError`, call `recordMalformed` (attempts 1), log a warning, and commit.
  - Otherwise wrap the dispatch in `retryWithBackoff` with the config values, `isRetryable = (e) => !(e instanceof MalformedPaymentMessageError)`, `heartbeat` from the payload, and an `onRetry` warning log with topic, partition, offset, `eventId`, `orderId`, attempt and delay.
  - On exhaustion, `recordRetriesExhausted(meta, lastError, maxAttempts)`, log an error, and commit.
  - Do **not** catch errors from the dead-letter repository: they propagate, so there is no commit (FR-013).

  Makes T042–T044 pass.

**Checkpoint**: all four stories work. SC-004 and SC-005 hold.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T048 [P] Create `docs/events/payment-processed.md` from `specs/002-react-to-payment-outcome/contracts/event-payment-processed.md`. Use the same structure as `docs/events/order-placed.md`: topic, producer (`ecommerce-payments`), payload, field table, the outcome for each status, idempotency, malformed and retry rules, and a link to the upstream contract (FR-020).
- [ ] T049 [P] Create `docs/events/payment-failed.md` the same way from `contracts/event-payment-failed.md` (FR-020).
- [ ] T050 [P] Update `docs/events/order-cancelled.md`. Add the optional `reason` field (payload example and table row, per `contracts/event-order-cancelled-delta.md`). Add the payment-failed trigger to "Emitted when". Replace the obsolete "Consumers" section ("producer only" / "separate future service") with the current consumers (planned read-model projection; other services).
- [ ] T051 [P] Update `src/README.md`. Add the consumer, the new service, the repositories and the entities to the folder table. Replace the "planned, not yet built" consumer section with the built payment consumer (keep the Mongo projection as planned). Mark `PaymentProcessed`/`PaymentFailed` as consumed in the events table. Add a "Where a payment message goes" flow line.
- [ ] T052 [P] Update the root `README.md`. Mark the payment consumers as **Built** in the events table, add the new environment variables to the env table, and add a short "Payment outcome" note (dedupe, dead-letter table, `KAFKA_CONSUMER_ENABLED`).
- [ ] T053 [P] Update `CLAUDE.md`. Change the consumed topics from "planned" to built for payments, and add the consumer rules location (`src/infra/kafka/payment-events.consumer.ts`) and the new env vars.
- [ ] T054 [P] Update the class doc comment of `OrderEventsProducer` in `src/infra/kafka/order-events.producer.ts`, which says "This service only ever produces these topics", to reflect that the service also consumes payment events. Comment only, no behaviour change.
- [ ] T055 Run the full quality gate (`npm run build`, `npm run lint`, `npm run format:check`, `npm run test`) and `npm run test:cov`, and confirm the 80% thresholds on `src/domain` and `src/services` still pass.
- [ ] T056 Validate end to end with `specs/002-react-to-payment-outcome/quickstart.md` §2–§3 against ecommerce-infra and a running `ecommerce-payments`: an order ≤ 10000 becomes CONFIRMED and an order > 10000 becomes CANCELLED within 5s, each with exactly one event. Record the results in the PR description.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001–T006)**: no dependencies. T005 needs T002–T004, and T006 needs T003–T004.
- **Foundational (T007–T016)**: needs Setup. Blocks every story.
- **US1 (T017–T026)**: needs Foundational. **MVP.**
- **US2 (T027–T036)**: needs Foundational, plus T024–T026 (the command, service and consumer created in US1). It can start in parallel with US1's tests, but its implementation extends files that US1 creates.
- **US3 (T037–T040)**: needs US1 (the service exists). Works with or without US2.
- **US4 (T041–T047)**: needs US1 (the consumer exists). T041, T045 and T046 can start right after Foundational.
- **Polish (T048–T056)**: after the stories it documents. T048–T054 are all [P].

### Story dependency graph

```text
Setup ──▶ Foundational ──▶ US1 (MVP) ──┬──▶ US2
                                       ├──▶ US3
                                       └──▶ US4 ──▶ Polish
```

### Within each story

Tests first, and confirm they fail. Then commands, domain, services, consumer, and the
integration and component tests turning green. Run the quality gate after every task.

---

## Parallel Examples

**Setup**: T002, T003 and T004 together (three entity files), then T005.

**Foundational**: T007 + T008 (tests), and T009 + T011 + T012 (enum, ref, DTOs) together. Then T010, T013, T014. Then T015 and T016.

**US1**: T017 + T018 + T019 together (three test files). Then T022, T024, T023, T025, T026. Then T020 and T021 go green.

**US2**: T027 + T028 + T029 together. Then T032, then T033 + T034, then T035, then T036.

**US4**: T041 + T045 (helper, test and implementation) and T046 (repository) in parallel with US2/US3 work. Then T042, T047, T043, T044.

**Polish**: T048–T054 all in parallel.

---

## Implementation Strategy

1. **MVP = Setup + Foundational + US1**: payment success confirms orders automatically. Demo it with quickstart §2 (success case only).
2. **Add US2**: the saga completes for both outcomes. This meets the main acceptance criterion.
3. **Add US3**: replay safety (acceptance: "replaying the same payment event changes nothing").
4. **Add US4**: resilience to poison messages and transient failures.
5. **Polish**: docs (FR-020/021), coverage, and the end-to-end check.

Each phase ends with a green quality gate and a Conventional Commit (`feat(US-04): …`,
`test(US-04): …`, `docs(US-04): …`).
