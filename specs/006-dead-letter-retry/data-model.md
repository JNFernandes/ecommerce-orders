# Data Model: Dead-Letter Retry (US-08)

Phase 1 output for [plan.md](plan.md). There is one migration and no new table.

## New enum `dead_letter_status_enum`

`PENDING_RETRY` | `RESOLVED` | `EXHAUSTED`

```text
           success                         permanent failure (malformed)
PENDING_RETRY ─────────▶ RESOLVED     PENDING_RETRY ─────────▶ EXHAUSTED
      │  ▲                                        ▲
      │  └─ transient failure, retryCount < max ──┘ (reschedule: nextRetryAt = now + delay)
      └──── transient failure, retryCount reaches max ─────────────────▶ EXHAUSTED
RESOLVED and EXHAUSTED are final (never claimed again).
```

## `order_dead_letters` (outbound; existing table, altered)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id`, `eventId`, `topic`, `payload` (jsonb), `error`, `createdAt` | existing | | | `payload` is the full serialized event (with `eventId`, `aggregateId`); `error` is the original publish error |
| `retryCount` | int | no | 0 | **existing**; now counts worker attempts |
| `status` | `dead_letter_status_enum` | no | `PENDING_RETRY` | **new** |
| `nextRetryAt` | timestamptz | no | `now()` | **new**; due when ≤ now |
| `lastAttemptAt` | timestamptz | yes | | **new** |
| `lastError` | text | yes | | **new**; last worker failure (the original stays in `error`) |
| `resolvedAt` | timestamptz | yes | | **new** |

Index: `IDX_order_dead_letters_due ON ("nextRetryAt", "createdAt") WHERE status = 'PENDING_RETRY'`.

## `consumed_message_dead_letters` (inbound; existing table, altered)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id`, `topic`, `partition`, `offset`, `messageKey`, `rawValue`, `eventId`, `orderId`, `failureType`, `error`, `attempts`, `createdAt` | existing | | | `attempts` = attempts **inside the consumer** before dead-lettering |
| `retryCount` | int | no | 0 | **new**; worker attempts |
| `status` | `dead_letter_status_enum` | no | `PENDING_RETRY` | **new**; inserted as `EXHAUSTED` when `failureType = MALFORMED` |
| `nextRetryAt` | timestamptz | no | `now()` | **new** |
| `lastAttemptAt`, `lastError`, `resolvedAt` | as above | yes | | **new** |

Index: `IDX_consumed_dead_letters_due ON ("nextRetryAt", "createdAt") WHERE status = 'PENDING_RETRY'`.

**Backfill** (in the same migration): `UPDATE consumed_message_dead_letters SET status = 'EXHAUSTED'
WHERE "failureType" = 'MALFORMED'`. Every other existing row of both tables gets the column
defaults: `PENDING_RETRY`, due now.

## Code-level types

| Type | Location | Shape |
|---|---|---|
| `DeadLetterStatus` | `src/infra/database/entities/dead-letter-status.enum.ts` | the 3 values |
| `RetrySettings` | `src/config/configuration.ts` (`deadLetter`) | `enabled, intervalMs, batchSize, baseDelayMs, maxDelayMs, maxRetries` |
| `AttemptResult` | `src/infra/dead-letter/retry-policy.ts` | `{ kind: 'success' } \| { kind: 'permanent'; error: string } \| { kind: 'transient'; error: string }` |
| `RetryUpdate` | same | `{ status, retryCount, nextRetryAt, lastAttemptAt, lastError, resolvedAt }` |
| `decideRetry(row, result, now, settings): RetryUpdate` | same | pure (R3) |
| `deadLetterDelay(retryCount, settings): number` | same | `min(base × 2^(n−1), max)` |

## Repository additions (existing repositories)

| Repository | New method | Contract |
|---|---|---|
| `OrderDeadLetterRepository` | `processNextDue(handler: (row: OrderDeadLetterEntity) => Promise<RetryUpdate>): Promise<boolean>` | In one transaction: `SELECT … WHERE status='PENDING_RETRY' AND "nextRetryAt" <= now() ORDER BY "nextRetryAt","createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`; `false` if none; else `await handler(row)`, apply the update, commit. A handler throw rolls back. |
| `ConsumedMessageDeadLetterRepository` | `processNextDue(handler)` | same, for the inbound table |
| `ConsumedMessageDeadLetterRepository` | `recordMalformed` (changed) | inserts with `status: EXHAUSTED` |

## Producer and consumer additions (reuse)

| Class | New member | Used by |
|---|---|---|
| `OrderEventsProducer` | `republish(topic, payload)`, key = `payload.aggregateId` | outbound retry |
| `PaymentEventsConsumer` | `readonly topics`; `process(topic, value)` (parse + handle, no retry or dead-letter) | `handleMessage` (live) and inbound retry |
| `OrderProjectionConsumer` | `readonly topics`; `process(topic, value)` | `handleMessage` (live) and inbound retry |
