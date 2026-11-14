# Research: Confirm on Payment and Stock (US-09)

Each decision below resolves a design question raised by the spec or by the existing code.

## R1. Concurrent outcomes for the same order (FR-009)

**Decision**: Optimistic concurrency on the outcome write. The repository updates the order with
`WHERE id = :id AND status = 'PENDING' AND "paymentOutcome" = :loadedPayment AND "stockOutcome" =
:loadedStock`, i.e. on the values the aggregate was loaded with. `affected = 0` throws the existing
retryable `OrderStatusChangedConcurrentlyError`; the consumer's retry-with-backoff reloads the
order and applies the outcome again, now seeing the other side.

**Rationale**: Payment and stock messages for one order come from different topics with different
keys (payment id, reservation id), so they can be processed in parallel, even by two instances.
The current `WHERE status = 'PENDING'` guard is not enough: two "first positive outcome" writes
would both succeed and leave a `PENDING` order with both outcomes positive and no confirmation.
Guarding on the loaded outcomes makes the second writer lose and retry. The same guard also
covers a REST cancel/confirm racing an outcome. It extends the pattern already in
`OrderRepository.applyInboundStatusChange`, and the retry path already exists.

**Alternatives considered**:
- `SELECT … FOR UPDATE` in one transaction around load, decide, save: deterministic with no
  retry, but the repository would have to run the domain decision inside its transaction
  (a callback through the persistence layer), which blurs Service → Domain → Repository.
- A `version` column on `orders`: equivalent, but adds a column whose only job the outcome
  columns already do.

## R2. Shape of the domain API

**Decision**: Four methods on `Order`: `recordPaymentProcessed()`, `recordPaymentFailed(reason)`,
`recordStockReserved()`, `recordStockRejected(reason)`. Each returns an `OutcomeApplication`
`{ record, attention }`: `record` is a domain `OutcomeRecord` (`RECORDED`, `CONFIRMED`,
`CANCELLED`, `IGNORED_DUPLICATE`, `IGNORED_ALREADY_CONFIRMED`, `IGNORED_ALREADY_CANCELLED`,
`IGNORED_CONFLICT`), stored as is in `processed_events`; `attention` is `NONE`,
`REFUND_NEEDED` or `CONFLICT`. A second, contradicting outcome on the same side of a `PENDING`
order is `IGNORED_CONFLICT` / `CONFLICT`: the first outcome of each side wins, as in US-04. Confirming or cancelling reuses the aggregate's existing
private transition code and raises the existing `OrderConfirmed` / `OrderCancelled` events. No
new event fields. Ignored outcomes never throw and never mutate the aggregate.

**Rationale**: The spec puts every rule in the domain (FR-006), including how an ignored outcome
is classified and which deserves a warning: "this payment needs a refund" is a business
classification. The service copies `record` and logs at warning level when `attention ≠ NONE`;
the repository maps `OutcomeRecord` to the entity enum by name. No classification happens
outside the domain (constitution Principle I). The existing
`confirm()` / `cancel()` keep their throwing behaviour for the REST endpoints (FR-020, FR-021).

**Alternatives considered**: Keeping a separate pure policy function like
`decidePaymentReaction`. Rejected: the user asked for aggregate methods, and with two outcome
columns the decision depends on aggregate state, not just status.

## R3. Enums

**Decision**: Extend the existing `src/domain/payment-outcome.enum.ts` with `PENDING`; add
`src/domain/stock-outcome.enum.ts` (`PENDING`, `RESERVED`, `REJECTED`). Delete
`payment-reaction.policy.ts` and its tests (US-04 rule removed, FR-006).

**Rationale**: One `PaymentOutcome` type, used both for the order's state and the parsed message.
The parser only ever produces `PROCESSED` or `FAILED`.

## R4. Reason text

**Decision**: The domain builds the reason: `payment failed: <reason>` / `stock rejected:
<reason>`, or just `payment failed` / `stock rejected` when the trimmed reason is empty. It is
stored as `cancellationReason` and carried by the existing `OrderCancelled.reason` field.

## R5. Schema (one migration)

**Decision**: Migration `20261114120000-AddOrderOutcomes.ts` (`AddOrderOutcomes20261114120000`):

1. `CREATE TYPE "orders_paymentoutcome_enum" AS ENUM ('PENDING','PROCESSED','FAILED')` and
   `"orders_stockoutcome_enum" AS ENUM ('PENDING','RESERVED','REJECTED')`.
2. `ALTER TABLE "orders" ADD "paymentOutcome" … NOT NULL DEFAULT 'PENDING'`, same for
   `"stockOutcome"`.
3. Backfill: `UPDATE "orders" SET "paymentOutcome" = 'PROCESSED', "stockOutcome" = 'RESERVED'
   WHERE "status" = 'CONFIRMED'`.
4. `processed_events`: `"paymentId"` becomes nullable, add `"reservationId" uuid NULL`, add
   `CHECK (num_nonnulls("paymentId", "reservationId") = 1)`.
5. `ALTER TYPE "processed_event_outcome_enum" ADD VALUE 'RECORDED'` and
   `ADD VALUE 'IGNORED_DUPLICATE'`.

`down()` reverses each step; since PostgreSQL cannot drop enum values, it recreates
`processed_event_outcome_enum` without the two values after deleting rows that use them, and
deletes stock rows from `processed_events` before restoring `"paymentId" NOT NULL`
(development database, acceptable).

**Rationale**:
- Column names follow the existing camelCase quoted style (`"cancellationReason"`,
  `"customerId"`). The request named them `payment_outcome` / `stock_outcome`, but it also asked
  to follow the existing naming; the table has no snake_case columns, so camelCase wins.
- A PostgreSQL enum matches how `status` is stored. A varchar + CHECK would also work, but would
  be the only such column.
- `ALTER TYPE … ADD VALUE` is allowed inside a transaction on PostgreSQL 16 (the infra and
  testcontainers version); the new values are not used inside the migration, so TypeORM's
  per-migration transaction is fine.
- Separate `paymentId` / `reservationId` columns keep the audit explicit and make "the source
  aggregate id is never an order id" visible in the schema.

**Alternatives considered**: Renaming `paymentId` to a generic `sourceAggregateId`. Rejected: it
loses which kind of id it is, and invites using it as a lookup key.

## R6. Processed-event outcomes

**Decision**: `ProcessedEventOutcome` gains `RECORDED` (first positive outcome stored, order still
`PENDING`) and `IGNORED_DUPLICATE` (outcome already recorded on a `PENDING` order), so it has the
same seven values as the domain `OutcomeRecord`, which decides them (R2, data-model.md).
`IGNORED_CONFLICT` now also covers a contradicting outcome on the same side of a `PENDING`
order.

## R7. Application layer

**Decision**:
- New commands `ApplyPaymentOutcomeCommand(outcome, inboundEvent, reason?)` and
  `ApplyStockOutcomeCommand(outcome, inboundEvent, reason?)`, handled by
  `ApplyPaymentOutcomeService` and `ApplyStockOutcomeService`.
- Both delegate to one shared, logic-free helper, `OutcomeWriteFlow` (`src/services/`): skip if
  the `eventId` is already processed → load by `orderId` (not found →
  `OrderNotFoundForOutcomeError`, retryable) → call the domain method passed in → on an `IGNORED_*`
  record, log it (warning when `attention ≠ NONE`, informational otherwise, see R8) and store
  the `record` as the processed event →
  otherwise `OrderRepository.applyOutcome(order, loaded, inbound, processedOutcome)` → publish the
  pulled event, dead-letter on publish failure.
- Remove `ReactToPaymentOutcomeCommand` / `ReactToPaymentOutcomeService`.
- `ConfirmOrderService` / `CancelOrderService` lose their `inboundEvent` branch and keep only the
  REST path (`updateStatus`), so the manual endpoints are unchanged (FR-020, FR-021).
  `OrderRepository.applyInboundStatusChange` is replaced by `applyOutcome`.
- `OrderNotFoundForPaymentError` is generalised to `OrderNotFoundForOutcomeError` (carries the
  source id); the consumer classification of retryable errors keeps treating it as retryable.

**Rationale**: Two thin handlers keep one command per message type (CQRS convention here); the
helper avoids duplicating the write flow. The helper has no `if` on business state: every branch
is on the domain's returned `record`.

A database outage while saving is a normal retryable failure, exactly as for the payment
consumer: retried with backoff, then dead-lettered as retryable and replayed by the US-08 worker
(spec FR-018). No `isFatal` is added; only the projection consumer has one.

## R8. Log levels (FR-005)

**Decision**: `attention = REFUND_NEEDED` or `CONFLICT` → `logger.warn`; other `IGNORED_*`
records → `logger.log` (informational, per the spec's "informational log line"). Each line includes
`orderId`, outcome, order status, `eventId`, topic and the payment or reservation id. The
refund warning starts with `payment needs refund:` so operators can search for it (SC-007).

## R9. Inventory consumer

**Decision**: `InventoryEventsConsumer` in `src/infra/kafka/inventory-events.consumer.ts`, a copy
of the `PaymentEventsConsumer` shape: own kafkajs consumer, `KafkaConnectLoop` started on
`onApplicationBootstrap`, `autoCommit: false`, `consumeWithDeadLetter` with the existing retry
settings (`PAYMENT_CONSUMER_*`), `process(topic, value)` and `topics` for the dead-letter worker.
Own consumer group `KAFKA_INVENTORY_GROUP_ID` (default `ecommerce-orders-inventory-consumer`),
added to `KafkaConfig`, `.env.example` and the README. Disabled with `KAFKA_CONSUMER_ENABLED`.
Registered in `DeadLetterRetryWorker`'s inbound handlers.

**Rationale**: A separate consumer next to the payment one, as requested. It needs its own group:
two kafkajs consumers in one group with different subscriptions get inconsistent assignments.
The user's "KafkaConsumerBase-style infrastructure" maps to `consumeWithDeadLetter` +
`KafkaConnectLoop`; there is no base class in the code and none is introduced (two consumers
share helpers today, and the projection consumer would not fit a base class).

**Alternatives considered**: Adding the two topics to `PaymentEventsConsumer` (one group, less
code). Rejected: the request asks for a separate consumer, and a stuck inventory partition would
then share a consumer with payments.

## R10. Stock message parser

**Decision**: `src/infra/kafka/stock-message.parser.ts` with `STOCK_RESERVED_TOPIC =
'inventory.stock-reserved'` and `STOCK_REJECTED_TOPIC = 'inventory.stock-rejected'`, DTOs
`StockReservedMessageDto` / `StockRejectedMessageDto` in `src/dto/`. Validates: JSON object;
`eventId`, `orderId`, `aggregateId` UUIDs; `occurredAt` ISO 8601; `version` equals `1`; on
rejections, `reason` optional string. `items`, `reservedAt`, `rejectedAt` are not validated
(informational, spec Key Entities). Throws `MalformedStockMessageError extends
MalformedMessageError`. Output: `{ outcome: StockOutcome.RESERVED | REJECTED, inboundEvent,
reason? }`, with `inboundEvent.reservationId = aggregateId` and `orderId` from `orderId`.

**Rationale**: Mirrors `parsePaymentMessage`. Topic names live as constants next to the parser,
like the payment topics: they are part of the contract, not deployment configuration (a breaking
change means a new topic, per Principle VII), so they are not environment variables.

## R11. `InboundEventRef`

**Decision**: `paymentId?: string` and `reservationId?: string`, exactly one set (the parsers
guarantee it; the DB CHECK enforces it). Log helpers print whichever is present.

## R12. Consistency with `ecommerce-infra/docs/events.md`

Differences that the implementation leaves in the infra file (it lives in another repo):

- The topics table lists Orders as a **planned** consumer of `inventory.stock-reserved` and
  `inventory.stock-rejected`; after US-09 it is implemented.
- "Planned behavior: until the Inventory stories land, Orders confirms on `PaymentProcessed`
  alone." becomes false.
- `orders.order-cancelled.reason` says "today: payment failures"; after US-09 it is
  `payment failed: …` or `stock rejected: …`, and is still omitted for REST cancels.

These go into the final summary as a follow-up PR on `ecommerce-infra`. The in-repo
`docs/events/` pages are written to match the infra file field for field.

## R13. ADR number

The request says "ADR 0004 is already created by the constitution chore". The ADR created there
is **0006** (`docs/adr/0006-order-joins-payment-and-stock-outcomes.md`); 0004 is the read-model
projection ADR. This plan updates 0006 (FR-025: record the manual-confirm decision).

## R14. Test strategy

- **Unit (domain)**: `test.each` over every sequence of one payment outcome and one stock
  outcome in both arrival orders (2 × 2 × 2 = 8 sequences), asserting the status, outcomes,
  reason and raised events after each step; repeats on `PENDING`; contradicting outcomes on the
  same side of a `PENDING` order (processed → failed, reserved → rejected); each of the 4
  outcomes on a `CONFIRMED` and on a `CANCELLED` order (8 cases) with the expected `record` and
  `attention`; empty reason.
- **Unit (application)**: both handlers with mocked repositories and producer: already
  processed, not found, recorded, confirmed, cancelled, ignored (log level), publish failure →
  dead letter, concurrent-change error propagates.
- **Unit (infra)**: stock parser (valid, each malformed case, unknown topic, reservation id ≠
  order id); inventory consumer dispatch; dead-letter worker routing to the new consumer.
- **Integration (real PostgreSQL)**: migration up/backfill/down; `OrderRepository.applyOutcome`
  (guard on loaded outcomes, conflict error, processed-event row with `reservationId`); inventory
  consumer handling (happy paths, duplicate, malformed, unknown order → dead letter, two
  positive outcomes applied concurrently → exactly one confirmation).
- **Component (real PostgreSQL + Kafka)**: place an order, publish payment then stock and stock
  then payment, assert `CONFIRMED` and one `OrderConfirmed`; publish stock rejected, assert
  `CANCELLED` with `stock rejected: insufficient stock`; publish payment processed after a
  cancellation, assert unchanged; existing payment component test updated for the join and the
  reason prefix.
