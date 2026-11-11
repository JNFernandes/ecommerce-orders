# Data Model: React to Payment Outcome (US-04)

Phase 1 output for [plan.md](plan.md). All changes ship in **one** new TypeORM migration,
`src/infra/database/migrations/<timestamp>-AddPaymentOutcomeConsumerSchema.ts`, with a full `down()`.

## Domain

### `Order` (aggregate root, existing, extended)

| Field | Type | Change |
|---|---|---|
| `cancellationReason` | `string \| null` | **New.** `null` unless the order was cancelled with a reason (only payment-driven cancellations supply one). |

| Method | Change |
|---|---|
| `cancel(reason?: string): void` | **Extended.** Same PENDING-only rule and `OrderCancellationError` as today. It now also stores `reason ?? null` in `cancellationReason` and passes it to `OrderCancelled`. |
| `confirm(): void` | Unchanged. |
| `reconstitute(..., cancellationReason?: string \| null)` | **Extended** with an optional trailing argument (default `null`), so existing callers compile unchanged. |

State transitions are unchanged:

```text
PENDING ──confirm()──▶ CONFIRMED
PENDING ──cancel(reason?)──▶ CANCELLED
CONFIRMED / CANCELLED: terminal (both methods throw)
```

### `OrderCancelled` (domain event, existing, extended)

| Field | Change |
|---|---|
| `reason?: string` | **New, optional.** Set only when `cancel()` received a reason. Omitted from the JSON when absent, so REST-driven cancellations are byte-identical to today. `version` stays `1`. |

### `PaymentOutcome` (new enum, `src/domain/payment-outcome.enum.ts`)

`PROCESSED` | `FAILED`

### `PaymentReaction` (new enum) and `decidePaymentReaction` (new policy)

`src/domain/payment-reaction.policy.ts`: a pure function with no I/O.

| Order status ↓ / Outcome → | `PROCESSED` | `FAILED` |
|---|---|---|
| `PENDING` | `CONFIRM` | `CANCEL` |
| `CONFIRMED` | `ALREADY_CONFIRMED` (silent no-op) | `CONFLICT` (warn, no-op) |
| `CANCELLED` | `CONFLICT` (warn, no-op) | `ALREADY_CANCELLED` (silent no-op) |

## Application

### `InboundEventRef` (value type passed in commands, `src/commands/inbound-event-ref.ts`)

| Field | Type | Notes |
|---|---|---|
| `eventId` | UUID string | Dedupe key. |
| `topic` | string | `payments.payment-processed` or `payments.payment-failed`. |
| `orderId` | UUID string | From the message's `orderId`. |
| `paymentId` | UUID string | From the message's `aggregateId`. Logged and stored for audit, **never** used to look up an order. |

### Commands

| Command | Shape | Handler |
|---|---|---|
| `ConfirmOrderCommand` | `(orderId, inboundEvent?: InboundEventRef)` | `ConfirmOrderService` (existing, extended) |
| `CancelOrderCommand` | `(orderId, options?: { reason?: string; inboundEvent?: InboundEventRef })` | `CancelOrderService` (existing, extended) |
| `ReactToPaymentOutcomeCommand` | `(outcome: PaymentOutcome, inboundEvent: InboundEventRef, reason?: string)` | `ReactToPaymentOutcomeService` (new) |

`ReactToPaymentOutcomeService.execute` returns a `ProcessedEventOutcome` (below), which is used for
logging and tests.

## Persistence (PostgreSQL)

### `orders` (existing table, altered)

| Column | Type | Null | Notes |
|---|---|---|---|
| `cancellationReason` | `text` | yes | **New.** Written by the transactional cancel path; REST cancellations leave it `NULL`. |

### `processed_events` (new table) ↔ `ProcessedEventEntity`

| Column | Type | Null | Notes |
|---|---|---|---|
| `eventId` | `uuid` | no | **Primary key.** A duplicate insert raises `23505`, which is treated as "already processed". |
| `topic` | `varchar` | no | Source topic. |
| `orderId` | `uuid` | no | Order the event referenced. No foreign key, so the audit row survives order deletion. |
| `paymentId` | `uuid` | no | The payment event's `aggregateId`. |
| `outcome` | `processed_event_outcome_enum` | no | `CONFIRMED`, `CANCELLED`, `IGNORED_ALREADY_CONFIRMED`, `IGNORED_ALREADY_CANCELLED`, `IGNORED_CONFLICT`. |
| `processedAt` | `timestamptz` | no | Default `now()`. |

Index: `IDX_processed_events_orderId` on `orderId` (for operator lookups).

### `consumed_message_dead_letters` (new table) ↔ `ConsumedMessageDeadLetterEntity`

Separate from `order_dead_letters`, which keeps holding outbound publish failures (spec FR-016).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | Primary key, generated. |
| `topic` | `varchar` | no | Source topic. |
| `partition` | `int` | no | |
| `offset` | `varchar` | no | Kafka offsets are int64 strings. |
| `messageKey` | `text` | yes | Raw key (the payment id from Payments), if any. |
| `rawValue` | `text` | yes | The raw message value, verbatim, even if it is not valid JSON. `NULL` for tombstones. |
| `eventId` | `uuid` | yes | Set when it could be parsed as a UUID. |
| `orderId` | `uuid` | yes | Set when it could be parsed as a UUID. |
| `failureType` | `varchar` | no | `MALFORMED` or `RETRIES_EXHAUSTED`. |
| `error` | `text` | no | Last error message. |
| `attempts` | `int` | no | `1` for malformed, otherwise the number of attempts made. |
| `createdAt` | `timestamptz` | no | Default `now()`. |

Index: `IDX_consumed_dead_letters_eventId` on `eventId` (non-unique: the same message could be
dead-lettered again after a crash between the dead-letter save and the offset commit).

### Transaction boundary (inbound path only)

Inside one `DataSource.transaction`:

1. `UPDATE orders SET status = :new, "updatedAt" = :at[, "cancellationReason" = :reason] WHERE id = :id AND status = 'PENDING'`.
   If 0 rows are affected, throw `OrderStatusChangedConcurrentlyError` (retryable) and roll back.
2. `INSERT INTO processed_events (...)`. On `23505`, throw `EventAlreadyProcessedError` and roll back.

After the commit, the service publishes the event (outbound dead-letter on failure). Only then
does the consumer commit the Kafka offset.

No-op outcomes insert only into `processed_events` (no transaction needed; `23505` means the
event is already processed, which is fine).

## Validation rules (inbound DTOs, `src/dto/`)

| DTO | Field | Rule |
|---|---|---|
| both | `eventId` | `@IsUUID()` |
| both | `orderId` | `@IsUUID()` |
| both | `aggregateId` | `@IsUUID()` (payment id) |
| both | `version` | `@Equals(1)` |
| `PaymentFailedMessageDto` | `reason` | `@IsOptional() @IsString()`, normalised to `''` when missing |

A failure in any of these, or a value that is not valid JSON, makes the message malformed
(dead-lettered without retries).

## Configuration (`src/config/configuration.ts`, `KafkaConfig` extended)

| Env var | Default | Meaning |
|---|---|---|
| `KAFKA_GROUP_ID` | `ecommerce-orders-consumer` | Existing; now actually used. |
| `KAFKA_CONSUMER_ENABLED` | `true` | Start the payment consumer on bootstrap. |
| `PAYMENT_CONSUMER_MAX_ATTEMPTS` | `5` | Attempts before dead-lettering a retryable failure. |
| `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS` | `1000` | First backoff delay. |
| `PAYMENT_CONSUMER_BACKOFF_MAX_MS` | `30000` | Backoff cap. |
