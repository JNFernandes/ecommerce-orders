# Research: React to Payment Outcome (US-04)

Phase 0 output for [plan.md](plan.md). Each entry records **Decision / Rationale / Alternatives
considered**. Facts about the Payments service were verified in `../ecommerce-payments` (source and
`specs/*/contracts/`), and facts about the local stack in `../ecommerce-infra/docker-compose.yml`.

---

## R1. Where the payment-outcome business rule lives

**Decision**: Add a pure domain policy, `src/domain/payment-reaction.policy.ts`, exporting
`decidePaymentReaction(status: OrderStatus, outcome: PaymentOutcome): PaymentReaction`. It returns
one of `CONFIRM`, `CANCEL`, `ALREADY_CONFIRMED`, `ALREADY_CANCELLED` or `CONFLICT`. The state
change itself still goes through the existing `Order.confirm()` / `Order.cancel()`.

**Rationale**: The status × outcome table (spec FR-003 to FR-009) is a business rule. Principle I
puts business rules in the domain, not in the consumer or the service. A pure function makes all
six combinations trivial to unit-test without NestJS.

**Alternatives considered**:
- *Let the consumer catch `OrderConfirmationError` / `OrderCancellationError` and treat them as
  no-ops*: hides the rule in exception handling, cannot tell "already in target state" (silent)
  from "conflicting state" (warning), and puts logic in the adapter.
- *New aggregate methods such as `order.applyPaymentSucceeded()`*: workable, but they would
  duplicate `confirm()` / `cancel()`. The policy plus the existing methods keeps one transition
  path for both REST and Kafka.

---

## R2. Reusing the ConfirmOrder / CancelOrder write flow

**Decision**: Keep `ConfirmOrderService` and `CancelOrderService` as the only code that changes an
order's status. Their commands gain an **optional** second argument:

- `ConfirmOrderCommand(orderId, inboundEvent?: InboundEventRef)`
- `CancelOrderCommand(orderId, options?: { reason?: string; inboundEvent?: InboundEventRef })`

When `inboundEvent` is present, the service saves the status change **and** the processed-event
record in one transaction, using a conditional update (R4). Otherwise it uses the existing
`updateStatus` path unchanged. The publish-after-save and dead-letter-on-publish-failure logic is
shared by both paths.

A new `ReactToPaymentOutcomeService` (a `@CommandHandler` for `ReactToPaymentOutcomeCommand`)
orchestrates the Kafka path. It runs the dedupe check, loads the order, asks the domain policy
(R1), and then either dispatches `ConfirmOrderCommand` / `CancelOrderCommand` through the
`CommandBus` or records a no-op.

**Rationale**: This is what the user asked for ("reuse the existing ConfirmOrder command and write
flow"). There is a single implementation of save-then-publish (Principle III). The REST
controller builds the commands with one argument, so its behaviour is unchanged (FR-018).

**Alternatives considered**:
- *A separate "confirm from payment" service*: duplicates the write flow and the dead-letter
  handling.
- *Dispatch the existing commands unchanged and insert the processed-event row afterwards*: not
  atomic (spec FR-012). Redelivery would still be harmless because the order is already in its
  target state, but the spec asks for atomicity and it also makes the audit trail exact.

---

## R3. Idempotency store

**Decision**: A new `processed_events` table keyed by `eventId` (UUID primary key). The service
checks it before doing anything (fast path). The insert inside the transaction is the real guard:
a unique-violation (`23505`) on `processed_events` rolls the transaction back, and the message is
treated as already processed. No-op outcomes are recorded too (spec assumption).

**Rationale**: Principle VII requires deduplication by `eventId`. A primary-key insert in the same
transaction as the status change is the simplest correct implementation with PostgreSQL. It needs
no locks and survives concurrent redelivery.

**Alternatives considered**: deduplicating by `orderId` (wrong: two distinct events for one order
must be distinguishable from a redelivery of one event); Redis or an in-memory set (not durable,
not transactional with the order change).

---

## R4. Concurrency: REST vs consumer, and per-order ordering

**Finding**: Payments publishes with **message key = payment id** (`PaymentEventPublisher.cs`).
The topics have **3 partitions** (`ecommerce-infra` `kafka-init`). Payments guarantees one outcome
per order, but nothing in Kafka guarantees per-order ordering, and an operator can call the REST
endpoint at any moment.

**Decision**: The transactional repository method updates with
`UPDATE orders SET status = $new, ... WHERE id = $id AND status = 'PENDING'`. If no row is
affected, the transaction is rolled back and a retryable `OrderStatusChangedConcurrentlyError` is
thrown. On retry, R1 re-evaluates against the fresh status and normally resolves to a no-op.

**Rationale**: Optimistic and cheap, with no row locks held during Kafka publishing. It turns
the "REST cancelled it a millisecond ago" race into the documented conflict outcome rather than
a lost update.

**Alternatives considered**: `SELECT ... FOR UPDATE` (pessimistic; holds a lock across domain
logic and adds no benefit at this volume); a `version` column (needs a schema and aggregate change
for the same effect).

The existing REST path keeps its unconditional `updateStatus` (FR-018: unchanged behaviour).
Hardening it is out of scope and noted as a follow-up.

---

## R5. Kafka consumer mechanics (kafkajs 2.2.4)

**Decision**:
- A single `consumer({ groupId: KAFKA_GROUP_ID })` subscribes to both topics with
  `fromBeginning: true`.
- `run({ autoCommit: false, eachMessage })`. Inside `eachMessage`, once the outcome has been
  durably saved (state change, no-op record, or dead-letter row), the consumer calls
  `consumer.commitOffsets([{ topic, partition, offset: String(BigInt(offset) + 1n) }])`.
- If saving the dead-letter row itself fails, `eachMessage` **throws** and no offset is committed.
  kafkajs then restarts the consumer from the last committed offset (redelivery, FR-013).
- `partitionsConsumedConcurrently` stays at the default of 1, so messages are processed one at a
  time per consumer instance.

**Rationale**: `autoCommit: false` with an explicit commit is the most direct way to guarantee
"commit only after the DB save" (Principle VII, FR-013). `fromBeginning: true` matters only the
first time a group starts (afterwards the committed offsets apply). It is safe because processing
is idempotent, and it avoids silently skipping outcomes published before the first deployment.

**Alternatives considered**: kafkajs `autoCommit` (commits resolved offsets on an interval, which
makes the commit point harder to reason about); NestJS microservices `@EventPattern` transport
(hides offset control and adds a second Kafka client alongside the existing raw kafkajs producer).

---

## R6. Retry with exponential backoff, then dead-letter

**Decision**: An in-process retry helper, `src/infra/kafka/retry-with-backoff.ts`.

- `delay(attempt) = min(initialMs × 2^(attempt-1), maxMs)` with ±20% jitter. The defaults are
  `maxAttempts = 5`, `initialMs = 1000` and `maxMs = 30000`, all configurable via env.
- `MalformedPaymentMessageError` is **non-retryable**. It is dead-lettered on the first failure.
- Every other error is retryable: order not found, concurrent status change, DB errors.
- While waiting between attempts, the helper calls the kafkajs `heartbeat()` at least every 3s so
  that a long backoff does not trigger a group rebalance (default `sessionTimeout` is 30s).

**Rationale**: This matches the spec (retry, then dead-letter, then continue) and keeps the
backoff bounded. With the defaults, the worst case before dead-lettering is about 1+2+4+8 ≈ 15s
of waiting. It only blocks the partition that holds the failing message (spec assumption).

**Alternatives considered**: retry topics (`*.retry-1`, `*.retry-2`) give non-blocking retries but
need extra topics in `ecommerce-infra` and more moving parts, which is overkill at this volume.
kafkajs's built-in `retry` restarts the whole consumer and offers no per-message dead-lettering.

---

## R7. Message validation (malformed vs valid)

**Decision**: The consumer parses the raw value with `JSON.parse`, then `plainToInstance` +
`validate` into `PaymentProcessedMessageDto` / `PaymentFailedMessageDto` (`src/dto/`), with
`whitelist`-style validation of only the fields this service uses:

- `eventId`: `@IsUUID()`
- `orderId`: `@IsUUID()`
- `aggregateId`: `@IsUUID()` (required: kept for logging and to assert it is never the order key)
- `version`: `@Equals(1)`
- `reason`: `@IsOptional() @IsString()` (payment-failed only; null or missing becomes `''`)

Other fields (`amount`, `currency`, `processedAt`, `failedAt`, `occurredAt`) are accepted but not
required. Any parse or validation failure throws `MalformedPaymentMessageError`.

**Rationale**: Principle IV requires a DTO with `class-validator` at every input boundary, and a
Kafka message is one. Validating only what is consumed makes the consumer tolerant of additive
upstream changes.

**Alternatives considered**: requiring every documented field, which would dead-letter valid
outcomes whenever Payments adds or renames an unused field.

---

## R8. Recording the failure reason

**Decision**:
- `orders.cancellationReason text NULL` (new column) and an `Order.cancellationReason: string | null`
  property.
- `Order.cancel(reason?: string)` sets it. The REST path calls `cancel()` without a reason, so it
  stays `null`.
- `OrderCancelled` gains an optional `reason` property. It is serialised only when set: `undefined`
  is dropped by `JSON.stringify`, so REST-driven cancellations produce exactly the current payload.
  The event `version` stays `1` because the change is additive (Principle VII).

**Rationale**: This implements spec FR-006 and FR-007 with zero change to the existing wire format
for REST cancellations.

---

## R9. Startup without blocking the HTTP API

**Decision**: `PaymentEventsConsumer` implements `OnApplicationBootstrap` and starts the consumer
**without awaiting** connect/run on the bootstrap path (fire-and-forget with `.catch` logging).
It relies on kafkajs's connection retry, and `OnApplicationShutdown` disconnects it. It is
controlled by `KAFKA_CONSUMER_ENABLED` (default `true`).

**Rationale**: FR-019 (HTTP stays up if the broker is down). The flag also lets the HTTP-only
integration tests and local debugging run without the consumer.

---

## R10. Testing approach

**Decision**:
- **Unit** (`tests/unit/`): the policy (all 6 status × outcome cells); `Order.cancel(reason)` and
  `OrderCancelled.reason`; the DTO validation table; the backoff helper (delays, cap,
  non-retryable short-circuit, heartbeat calls); `ReactToPaymentOutcomeService` (duplicate,
  unknown order, no-op recording, dispatch); the extended Confirm/Cancel services (inbound path
  uses the transactional repository method; REST path unchanged); and the consumer's
  `handleMessage` (commit after outcome, dead-letter on malformed, dead-letter after max attempts,
  no commit if the dead-letter write fails) with mocked collaborators.
- **Integration** (`tests/integration/react-to-payment-outcome.integration.spec.ts`): a real
  PostgreSQL testcontainer with the Kafka producer mocked. It feeds raw `KafkaMessage`-shaped
  inputs to the consumer's message handler and asserts `orders`, `processed_events` and
  `consumed_message_dead_letters` rows, including duplicate delivery and the conditional-update
  race.
- **Component** (`tests/component/react-to-payment-outcome.component.spec.ts`): real PostgreSQL
  and Kafka containers and the full consumer. It places an order via `POST /orders`, publishes a
  `payments.payment-processed` (and in another case `payments.payment-failed`) message, polls the
  DB until the status changes (≤ 10s), asserts that exactly one `OrderConfirmed` /
  `OrderCancelled` is observed, re-publishes the same message, and asserts that nothing changes.
  Backoff is set to milliseconds via env in tests.

**Rationale**: Principles V and VI: three layers, and the component test uses real Kafka and
PostgreSQL as the user requested.
