# Tasks: Confirm an Order Only When Payment Succeeded and Stock Was Reserved (US-09)

**Input**: `specs/007-confirm-on-payment-and-stock/` — [plan.md](plan.md), [spec.md](spec.md),
[research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/),
[quickstart.md](quickstart.md)

**Tests**: Required (spec Assumptions "Tests required", constitution Principles V and VI).

## Conventions

- `- [ ] T### [P] [USn] description`. **[P]** = touches different files from the other [P]
  tasks of the same phase and depends on no unfinished task in it; safe to run in parallel.
- **Story labels** map to spec user stories: US1 confirm on both positive, US2 cancel on first
  negative, US3 ignore when not `PENDING`, US4 stock message reliability, US5 data upgrade.
  The phases follow the layer order requested (domain → migration → application → messaging →
  component → docs); each task carries the story it serves.
- **Test first**: inside each task, write or update the tests first and see them fail for the
  expected reason, then implement until they pass. A task is never committed with a failing test.
- **Gate** (end of every task, in this order, all must pass, constitution IX):
  `npm run build` → `npm run lint` → `npm run format:check` → `npm run test`.
  Fix any failure inside the same task.
- **One task = one commit**, Conventional Commits scoped `US-09`
  (`feat(US-09): …`, `test(US-09): …`, `refactor(US-09): …`, `docs(US-09): …`).
- Design references: R1–R14 are in research.md; transition tables are in data-model.md.

---

## Phase 1: Setup

- [ ] T001 Confirm the baseline: on `feature/US-09-confirm-on-payment-and-stock`, Docker running, run the **gate** on the unchanged code and record any pre-existing failure before starting (no code change, no commit if nothing changed).

---

## Phase 2: Domain (test first)

**Goal**: all join rules live in `Order` (FR-001–FR-006, R2–R4). Pure unit tests, no Nest/DB/Kafka.

- [ ] T002 Add `PENDING` to `PaymentOutcome` in `src/domain/payment-outcome.enum.ts`; create `src/domain/stock-outcome.enum.ts` (`PENDING`, `RESERVED`, `REJECTED`) and `src/domain/outcome-application.ts` (`OutcomeApplication` = `{ record: OutcomeRecord, attention: Attention }`; `OutcomeRecord` `RECORDED` / `CONFIRMED` / `CANCELLED` / `IGNORED_DUPLICATE` / `IGNORED_ALREADY_CONFIRMED` / `IGNORED_ALREADY_CANCELLED` / `IGNORED_CONFLICT`; `Attention` `NONE` / `REFUND_NEEDED` / `CONFLICT`; see data-model.md), all with JSDoc on every member. Check the parser in `src/infra/kafka/payment-message.parser.ts` still only emits `PROCESSED`/`FAILED`. **Gate.**
- [ ] T003 [US1] Add `paymentOutcome` and `stockOutcome` to `Order` in `src/domain/order.aggregate.ts`: `place()` sets both `PENDING`; `reconstitute(...)` takes them as trailing optional parameters defaulting to `PENDING`. Tests first in `tests/unit/domain/order-outcomes.spec.ts` (new): a placed order has both `PENDING`; reconstitute keeps the given values. Existing `tests/unit/domain/` tests must pass unchanged. **Gate.**
- [ ] T004 [US1] Implement `recordPaymentProcessed()` and `recordStockReserved()` in `src/domain/order.aggregate.ts` for a `PENDING` order: first positive → outcome set, `RECORDED`, no event; second positive → status `CONFIRMED`, `updatedAt` refreshed, one `OrderConfirmed` raised (reuse the transition code of `confirm()` through a private helper, without changing `confirm()`'s behaviour), `CONFIRMED`; repeat of a recorded positive → `IGNORED_DUPLICATE` / `NONE`, no change. Every non-ignored result has `attention` `NONE`. Tests first in `tests/unit/domain/order-outcomes.spec.ts`. **Gate.**
- [ ] T005 [US2] Implement `recordPaymentFailed(reason?)` and `recordStockRejected(reason?)` in `src/domain/order.aggregate.ts` for a `PENDING` order whose outcome on that side is still `PENDING` (the other side may be anything). If that side is already positive (payment failed after payment processed, stock rejected after stock reserved), return `IGNORED_CONFLICT` / `CONFLICT` with no change: the first outcome of each side wins (spec FR-004, Story 3 scenario 6). Otherwise: outcome set, status `CANCELLED`, `cancellationReason` = `payment failed: <reason>` / `stock rejected: <reason>`, or `payment failed` / `stock rejected` when the trimmed reason is empty or missing (R4); one `OrderCancelled` raised carrying that reason (existing field, no new field); result `CANCELLED`. Reuse `cancel()`'s transition code through the same private-helper approach. Tests first, including empty, whitespace and missing reason, "payment processed then stock rejected" (cancels), and the two same-side contradictions (ignored as conflict). **Gate.**
- [ ] T006 [US3] Implement the non-`PENDING` branch of all four `record*()` methods in `src/domain/order.aggregate.ts` per data-model.md "On a non-PENDING order": no mutation, no event; `record` / `attention` exactly as in that table (`IGNORED_ALREADY_CONFIRMED` / `NONE`, `IGNORED_CONFLICT` / `CONFLICT` for a negative on `CONFIRMED`, `IGNORED_CONFLICT` / `REFUND_NEEDED` for payment processed on `CANCELLED`, `IGNORED_ALREADY_CANCELLED` / `NONE`). Tests first: all 8 combinations (2 statuses × 4 outcomes) with `test.each`, asserting status, outcomes, reason and `pullDomainEvents()` are unchanged. **Gate.**
- [ ] T007 [US1] [US2] [US3] Add the arrival-order matrix to `tests/unit/domain/order-outcomes.spec.ts` (test-only): with `test.each`, every sequence of one payment outcome (processed/failed) and one stock outcome (reserved/rejected) in both orders (8 sequences), asserting after each step the status, both outcomes, the reason, `record`, `attention` and the events raised; plus "first negative wins" for failed+rejected in both orders, and "first outcome of a side wins" for processed→failed and reserved→rejected while the other side is pending. Name tests by behaviour ("should confirm when stock is reserved after the payment was processed"). **Gate.**

**Checkpoint**: the domain alone satisfies the whole data-model transition table.

---

## Phase 3: Persistence (migration and repository)

**Goal**: outcomes stored and guarded against concurrent writes (FR-009, FR-024, R1, R5, R6).

- [ ] T008 [US5] Create `src/infra/database/migrations/20261114120000-AddOrderOutcomes.ts` (class `AddOrderOutcomes20261114120000`, style of `20261111120000-AddPaymentOutcomeConsumerSchema.ts`) implementing R5 steps 1–5 and the `down()` described there. In the same task, add `paymentOutcome` / `stockOutcome` columns (`type: 'enum'`, `enumName` `orders_paymentoutcome_enum` / `orders_stockoutcome_enum`, default `PENDING`) to `src/infra/database/entities/order.entity.ts`, and `reservationId` (nullable uuid), nullable `paymentId`, and `RECORDED` / `IGNORED_DUPLICATE` to `src/infra/database/entities/processed-event.entity.ts`, so entities and schema match. **Gate.**
- [ ] T009 [US5] Write `tests/integration/order-outcomes-migration.integration.spec.ts` (real PostgreSQL via the existing `tests/integration/support/`): run migrations up to the previous one, insert one `PENDING`, one `CONFIRMED`, one `CANCELLED` order, run `AddOrderOutcomes`, assert the backfill (CONFIRMED → `PROCESSED`/`RESERVED`, others `PENDING`/`PENDING`) and the default for a new row; assert the `processed_events` one-of CHECK rejects both-null and both-set; run `down()` and assert the columns and types are gone. **Gate.**
- [ ] T010 [US4] Make `paymentId` optional and add `reservationId?: string` in `src/commands/inbound-event-ref.ts` (JSDoc: never an order id); write whichever is set in `src/repositories/processed-event.repository.ts`; update every compile error this causes (log `describe` helpers print the id that is present; `src/services/errors/payment-outcome.errors.ts` accepts an optional source id). Update the affected unit tests. **Gate.**
- [ ] T011 [US1] [US2] Map `paymentOutcome` / `stockOutcome` in `OrderRepository.save()` and `findById()` (`src/repositories/order.repository.ts`), and add `applyOutcome(order, loaded: { paymentOutcome, stockOutcome }, inbound, processedOutcome)` per data-model.md "Outcome write": one transaction, guarded update on `status = PENDING` and the loaded outcomes, `affected = 0` → `OrderStatusChangedConcurrentlyError`, then the `processed_events` insert (unique violation → `EventAlreadyProcessedError`). Keep `applyInboundStatusChange` for now (removed in T017). Tests first in `tests/integration/order-repository.outcomes.integration.spec.ts` (new): round trip of outcomes; first positive saved; guard rejects a stale `loaded`; duplicate `eventId` rejected; row written with `reservationId`. **Gate.**

**Checkpoint**: migration runs on the dev database (`npm run migration:run`), outcomes persist.

---

## Phase 4: Application handlers

**Goal**: one write flow for both outcome kinds; US-04 rule removed; REST unchanged (FR-007,
FR-008, FR-020–FR-022, R7, R8).

- [ ] T012 [US4] Rename `OrderNotFoundForPaymentError` to `OrderNotFoundForOutcomeError` (order id, topic, source id) and move the file to `src/services/errors/outcome.errors.ts` (keep `EventAlreadyProcessedError` there); update all imports in `src/` and `tests/`. It must stay retryable in `consumeWithDeadLetter` (it is not a `MalformedMessageError`). **Gate.**
- [ ] T013 [US1] [US2] [US3] Create `src/services/outcome-write-flow.ts` (injectable, no business branching): `run(inbound, apply: (order) => OutcomeApplication)` → skip if `eventId` already processed (returns `ALREADY_PROCESSED`) → load by `inbound.orderId` (missing → `OrderNotFoundForOutcomeError`) → capture loaded outcomes → `apply(order)` → `record` is `IGNORED_*`: log per R8 (warn for `REFUND_NEEDED` with message prefix `payment needs refund:`, warn for `CONFLICT`, `log` otherwise) and `ProcessedEventRepository.recordOutcome` with the domain's `record` copied as is (the repository maps `OutcomeRecord` → `ProcessedEventOutcome` by name; the flow makes no classification of its own) → otherwise `OrderRepository.applyOutcome(...)`, then publish the pulled `OrderConfirmed` / `OrderCancelled` via `OrderEventsProducer`, and on publish failure log and `OrderDeadLetterRepository.recordFailure` (same as `ConfirmOrderService`); a concurrently recorded `eventId` (`EventAlreadyProcessedError`) returns `ALREADY_PROCESSED`. Tests first in `tests/unit/services/outcome-write-flow.spec.ts` with mocks: each `record` value is passed through unchanged, log level per attention, save-before-publish order, publish failure → dead letter and success, not found, concurrent-change error propagates. **Gate.**
- [ ] T014 [P] [US1] [US2] Create `src/commands/apply-stock-outcome.command.ts` (`outcome: StockOutcome.RESERVED | REJECTED`, `inboundEvent`, `reason?`) and `src/services/apply-stock-outcome.service.ts` (`@CommandHandler`, calls `OutcomeWriteFlow.run` with `recordStockReserved` / `recordStockRejected(reason)`). Tests first in `tests/unit/services/apply-stock-outcome.service.spec.ts`. Not yet registered. **Gate.**
- [ ] T015 [P] [US1] [US2] Create `src/commands/apply-payment-outcome.command.ts` and `src/services/apply-payment-outcome.service.ts`, mirroring T014 with `recordPaymentProcessed` / `recordPaymentFailed(reason)`. Tests first in `tests/unit/services/apply-payment-outcome.service.spec.ts`. Not yet registered. **Gate.**
- [ ] T016 [US1] [US2] [US3] Switch payments to the join: register `OutcomeWriteFlow`, `ApplyPaymentOutcomeService`, `ApplyStockOutcomeService` in `src/app.module.ts`; make `src/infra/kafka/payment-events.consumer.ts` dispatch `ApplyPaymentOutcomeCommand`; delete `src/services/react-to-payment-outcome.service.ts`, `src/commands/react-to-payment-outcome.command.ts`, `src/domain/payment-reaction.policy.ts` and their tests (`tests/unit/services/react-to-payment-outcome.service.spec.ts`, `tests/unit/domain/payment-reaction.policy.spec.ts`). Update for the new behaviour: `tests/unit/infra/payment-events.consumer.spec.ts`; `tests/integration/react-to-payment-outcome.integration.spec.ts` → rename to `apply-payment-outcome.integration.spec.ts` (payment processed alone leaves the order `PENDING` with `paymentOutcome = PROCESSED`; confirm after the stock outcome is set; reason now `payment failed: …`); `tests/component/react-to-payment-outcome.component.spec.ts`, `tests/component/dead-letter-retry.component.spec.ts` and `tests/component/kafka-unavailable.component.spec.ts` wherever they expect confirmation on payment alone or the bare reason. **Gate.**
- [ ] T017 [US3] Make the manual endpoints REST-only (FR-020, FR-021): remove `inboundEvent` from `src/commands/confirm-order.command.ts` and `src/commands/cancel-order.command.ts` and the inbound branches from `src/services/confirm-order.service.ts` / `src/services/cancel-order.service.ts`; remove `OrderRepository.applyInboundStatusChange`. Update `tests/unit/services/confirm-order.service.spec.ts` and `cancel-order.service.spec.ts`. `tests/integration/confirm-order.integration.spec.ts`, `cancel-order.integration.spec.ts` and the confirm/cancel component tests must pass **unchanged** (SC-006 of US-04). Add one **new** test case to each of those two integration specs (existing cases untouched): an order with `paymentOutcome = PROCESSED` and `stockOutcome = PENDING` is confirmed (resp. cancelled) through REST, and both outcomes are unchanged afterwards (FR-020, FR-021). **Gate.**

**Checkpoint**: payments behave per the join; the service is consistent, though no stock outcome
can arrive yet.

---

## Phase 5: Messaging (parser and consumer)

**Goal**: consume `inventory.stock-reserved` / `inventory.stock-rejected` reliably (FR-010–FR-019,
R9–R11).

- [ ] T018 [P] [US4] Create `src/dto/stock-reserved-message.dto.ts` and `src/dto/stock-rejected-message.dto.ts` (`class-validator`: `eventId`, `aggregateId`, `orderId` UUID; `occurredAt` ISO 8601; `version` equals 1; `reason` optional string on rejected; other fields ignored) and `src/infra/kafka/stock-message.parser.ts` (`STOCK_RESERVED_TOPIC`, `STOCK_REJECTED_TOPIC`, `MalformedStockMessageError extends MalformedMessageError`, `parseStockMessage(topic, value)` → `{ outcome, inboundEvent: { eventId, topic, orderId, reservationId: aggregateId }, reason? }`), mirroring `payment-message.parser.ts`. Tests first in `tests/unit/infra/stock-message.parser.spec.ts`: both topics valid; `orderId` used and `aggregateId` only as `reservationId` (ids differ in the fixture); null value, invalid JSON, non-object, missing/invalid `eventId`/`orderId`/`aggregateId`, bad `occurredAt`, `version` 2, unknown topic → malformed; missing reason accepted. **Gate.**
- [ ] T019 [P] [US4] Add `inventoryGroupId` (`KAFKA_INVENTORY_GROUP_ID`, default `ecommerce-orders-inventory-consumer`, JSDoc) to `KafkaConfig` in `src/config/configuration.ts` and to `.env.example`; extend the configuration unit test if one exists under `tests/unit/`. **Gate.**
- [ ] T020 [US4] Create `src/infra/kafka/inventory-events.consumer.ts` (`InventoryEventsConsumer`, same shape as `PaymentEventsConsumer`: own consumer with `groupId: config.inventoryGroupId`, `KafkaConnectLoop` named `inventory events consumer` started in `onApplicationBootstrap` and skipped when `consumerEnabled` is false, `autoCommit: false`, `handleMessage` via `consumeWithDeadLetter` with `parseStockMessage` and the shared retry settings, `process(topic, value)`, `topics`); register it in the `providers` of `src/app.module.ts`, next to `PaymentEventsConsumer`. No awaited `connect()` in factories or hooks, and no `isFatal` option: a database failure is retried, then dead-lettered as retryable, like the payment consumer (FR-018). Tests first in `tests/unit/infra/inventory-events.consumer.spec.ts`: dispatches `ApplyStockOutcomeCommand`, commits `offset + 1` after success, malformed → dead letter + commit, a handler error that persists through all attempts → retryable dead letter + commit, disabled flag → no connect. **Gate.**
- [ ] T021 [US4] Register `InventoryEventsConsumer` as an inbound handler of `src/infra/dead-letter/dead-letter-retry.worker.ts` (constructor injection next to `PaymentEventsConsumer`) so retried rows for `inventory.*` topics go through its `process()` (FR-017). Tests first in the worker's existing unit spec under `tests/unit/infra/`: an `inventory.stock-reserved` row is routed to the inventory consumer. **Gate.**
- [ ] T022 [US4] Write `tests/integration/inventory-events.integration.spec.ts` (real PostgreSQL, `handleMessage` with a fake payload and mocked `commitOffsets`, like `apply-payment-outcome.integration.spec.ts`): stock reserved then payment processed → `CONFIRMED`; stock rejected → `CANCELLED` with `stock rejected: insufficient stock`; same `eventId` twice → one change; malformed → `consumed_message_dead_letters` row `EXHAUSTED` and commit; unknown `orderId` → retries then `PENDING_RETRY` dead letter (small backoff settings); payment processed then payment failed on a still-pending order → stays `PENDING`, `processed_events` row `IGNORED_CONFLICT`; **concurrency**: payment processed and stock reserved applied with `Promise.all` on the same order → exactly one `CONFIRMED` and one `OrderConfirmed` publish (FR-009, SC-004); `processed_events` row has `reservationId` and no `paymentId`. **Gate.**

**Checkpoint**: both outcome sources work against a real database.

---

## Phase 6: Component tests (real Kafka + PostgreSQL)

- [ ] T023 [US1] [US2] [US3] Write `tests/component/order-outcomes.component.spec.ts` with the existing `tests/component/support/` helpers; add `inventory.stock-reserved` and `inventory.stock-rejected` to the topics created via `createTopicsWhenReady`. Scenarios: place an order via REST, publish payment processed then stock reserved → `CONFIRMED` and exactly one message on `orders.order-confirmed`; the reverse order → same; stock rejected (`aggregateId` ≠ order id) → `CANCELLED` and `orders.order-cancelled` with `reason: "stock rejected: insufficient stock"`; payment processed after that cancellation → order unchanged, no further order event. Every wait for a final status or an order event uses a **5 s** limit, measured from publishing the deciding outcome; exceeding it fails the test (SC-001, SC-002). **Gate.**
- [ ] T024 [P] [US4] Extend `tests/component/kafka-unavailable.component.spec.ts` so the app with the inventory consumer enabled starts and serves `POST /orders` while Kafka is unreachable, and extend `tests/component/dead-letter-retry.component.spec.ts` with a stock message for an unknown order that is resolved by the worker once the order exists. **Gate.**

---

## Phase 7: Documentation

All [P]: separate files. Keep `docs/events/` consistent with `ecommerce-infra/docs/events.md`
(constitution Documentation Standards).

- [ ] T025 [P] [US4] Create `docs/events/stock-reserved.md` and `docs/events/stock-rejected.md` from `contracts/event-stock-reserved.md` and `contracts/event-stock-rejected.md`, in the style of `docs/events/payment-processed.md`, field for field with the infra file. **Gate.**
- [ ] T026 [P] [US2] Update `docs/events/order-cancelled.md` (reason values per `contracts/event-order-cancelled-delta.md`), `docs/events/order-confirmed.md` (published when both outcomes are positive or manually), `docs/events/payment-processed.md` (records the payment; confirms only with stock reserved) and `docs/events/payment-failed.md` (reason prefix). **Gate.**
- [ ] T027 [P] [US1] Update `README.md`: "Order lifecycle" status line (built, no longer "planned"), the two `inventory.*` rows → `Built`, rename "Payment outcome consumer" to cover both consumers, the env table (`KAFKA_INVENTORY_GROUP_ID`; `KAFKA_CONSUMER_ENABLED` now starts three consumers), the `docs/events/` mentions. **Gate.**
- [ ] T028 [P] Update `src/README.md` (commands, services, domain rows: `record*()`, `OutcomeWriteFlow`, `Apply*OutcomeService`, `InventoryEventsConsumer`, `stock-message.parser`; remove `decidePaymentReaction` / `ReactToPaymentOutcome*`) and `CLAUDE.md` (Event contracts: stock topics built, consumer file, group env var, remove "Until the stock consumer lands…"). **Gate.**
- [ ] T029 [P] Update `docs/adr/0006-order-joins-payment-and-stock-outcomes.md`: replace the open "decide the fate of the manual endpoint" consequence with the decision (operator override, spec FR-020) and note the concurrency guard (research R1). **Gate.**

---

## Phase 8: Polish

- [ ] T030 Run `npm run test:cov` and confirm ≥ 80% on `src/domain` and `src/services`; walk through [quickstart.md](quickstart.md) section 2 against the local infra; write down, for the final summary, the differences left in `ecommerce-infra/docs/events.md` (research R12). No commit unless a fix was needed. **Gate.**

---

## Dependencies

```text
T001 → T002 → T003 → T004 → T005 → T006 → T007        (domain, one file: sequential)
T007 → T008 → T009                                     (migration, then its test)
T008 → T010 → T011                                     (inbound ref, repository)
T011 → T012 → T013 → {T014, T015} → T016 → T017        (application)
T016 → {T018, T019} → T020 → T021 → T022               (messaging; T018/T019 only need T010)
T022 → T023, T024                                      (component)
T023 → {T025, T026, T027, T028, T029} → T030           (docs, polish)
```

- Story completion: **US5** done at T009; **US1/US2/US3** done for payments at T017 and for
  stock at T022 (end to end at T023); **US4** done at T024.
- T018 and T019 only depend on T010, so they may start as soon as Phase 3 is done if someone
  works on messaging in parallel with Phase 4.

## Parallel Examples

```text
Phase 4:  T014 (stock handler)  ‖  T015 (payment handler)
Phase 5:  T018 (DTOs + parser)  ‖  T019 (config)
Phase 6:  T024 (startup / DLQ component) alongside T023 once T022 is done
Phase 7:  T025 ‖ T026 ‖ T027 ‖ T028 ‖ T029
```

## Implementation Strategy

- **MVP = through T017**: the join works for every combination at the domain and persistence
  level, payments use it, REST is unchanged. Not shippable on its own, though: without the stock
  consumer no order is confirmed automatically any more, so do not merge before T022.
- **Shippable increment = through T023**: stock outcomes consumed, end-to-end proven.
- T024–T030 harden and document; all must land in the same PR (constitution: docs and tests are
  part of done).
