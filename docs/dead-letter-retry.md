# Dead-letter retry (US-08)

When something fails after a successful save or a consumed message can't be processed, the
service keeps a **dead letter** in PostgreSQL. A background worker retries it, so a temporary
outage loses nothing. Design rationale: [ADR 0005](adr/0005-dead-letter-retry.md).

## The two stores

| Table | Direction | What lands there | How it is retried |
|---|---|---|---|
| `order_dead_letters` | Outbound | An order event (`OrderPlaced`/`Confirmed`/`Cancelled`) whose Kafka publish failed **after** the DB save. The REST request still succeeded. | Republished through `OrderEventsProducer.republish` to the stored topic: the stored payload, the **same `eventId`**, keyed by `aggregateId` |
| `consumed_message_dead_letters` | Inbound | A consumed message that could not be processed: malformed (`failureType MALFORMED`) or failing on every in-consumer attempt (`RETRIES_EXHAUSTED`) | Re-handled by the consumer that owns the topic, through its `process()`: `payments.*` → `PaymentEventsConsumer` (payment-outcome command), `orders.*` → `OrderProjectionConsumer` (read-model projection) |

Inbound retries use the same parsing and the same idempotent handlers as live consumption, so
the usual duplicate protection applies: a payment already recorded in `processed_events`, or an
event already in a view's `appliedEventIds`, is a no-op that counts as success. Retries never
commit Kafka offsets and never create new dead letters.

## States

```text
PENDING_RETRY ──success──────────────────────────────▶ RESOLVED   (final)
      │  ▲
      │  └── transient failure, retries left: nextRetryAt = now + delay
      ├───── transient failure, retryCount reaches DEAD_LETTER_MAX_RETRIES ─▶ EXHAUSTED (final)
      └───── permanent failure (malformed, unknown topic, no value) ────────▶ EXHAUSTED (final)
```

- Only `PENDING_RETRY` rows with `nextRetryAt <= now()` are picked up.
- `RESOLVED` and `EXHAUSTED` rows are never claimed again. Nothing deletes them (no purge yet).
- Malformed inbound messages are stored directly as `EXHAUSTED`: they can never succeed.
- Exhaustion logs an **error** with the row id, direction, topic, `eventId`, `orderId` (inbound),
  `retryCount` and the last error. Each failed attempt logs a warning.

### Columns

| Column | Meaning |
|---|---|
| `status` | `PENDING_RETRY` / `RESOLVED` / `EXHAUSTED` (`dead_letter_status_enum`) |
| `retryCount` | Attempts made **by the worker** |
| `nextRetryAt` | When the row is next due |
| `lastAttemptAt` | When the worker last tried it |
| `lastError` | The worker's last error. The original failure stays in `error`. |
| `resolvedAt` | When a retry succeeded |

Don't confuse the two counters and the two "exhausted"s on the inbound table:

- `attempts` counts the attempts **inside the consumer** before the message was dead-lettered;
  `retryCount` counts the worker's attempts afterwards.
- `failureType RETRIES_EXHAUSTED` means the *consumer* gave up (the row is then retried by the
  worker); `status EXHAUSTED` means the *worker* gave up.

## Schedule

The delay after the n-th failed attempt is `min(DEAD_LETTER_BASE_DELAY_MS × 2^(n−1),
DEAD_LETTER_MAX_DELAY_MS)`, with no jitter. With the defaults:

| Failed attempt | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Next try after | 5 s | 10 s | 20 s | 40 s | 80 s | 160 s | 320 s | — (`EXHAUSTED`) |

A row is only picked up on a worker cycle, so the real gap is the delay rounded up to the next
cycle (every 30 s by default). From the first worker attempt to exhaustion takes about 11 minutes.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DEAD_LETTER_RETRY_ENABLED` | `true` | `false` turns the worker off |
| `DEAD_LETTER_RETRY_INTERVAL_MS` | `30000` | Pause between the end of one cycle and the start of the next |
| `DEAD_LETTER_BATCH_SIZE` | `20` | Maximum rows attempted per store per cycle |
| `DEAD_LETTER_BASE_DELAY_MS` | `5000` | Delay after the first failed attempt |
| `DEAD_LETTER_MAX_DELAY_MS` | `600000` | Cap on any delay |
| `DEAD_LETTER_MAX_RETRIES` | `8` | Worker attempts before `EXHAUSTED` |

## How the worker runs

- `DeadLetterRetryWorker` (`src/infra/dead-letter/`) runs in **every instance**. The first cycle
  starts one interval after startup and never delays it.
- Each cycle runs to completion, then schedules the next one, so cycles never overlap. A cycle
  drains up to `DEAD_LETTER_BATCH_SIZE` outbound rows, then up to as many inbound rows.
- **Claiming**: each row is handled in **its own transaction**:
  `SELECT … WHERE status = 'PENDING_RETRY' AND "nextRetryAt" <= now() ORDER BY "nextRetryAt",
  "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`, then the attempt, then the update, then commit.
  - Another instance skips a locked row and takes the next one, so **two workers never process
    the same row**.
  - If the process dies mid-attempt, PostgreSQL rolls back and the row is immediately due again
    (no lease to expire).
  - A lock is held for at most one attempt, using one pooled connection.
- **Shutdown** (`enableShutdownHooks`): the worker stops scheduling, the cycle stops before its
  next row, and shutdown waits for at most the attempt in flight.
- A database error in a cycle is logged and the next cycle tries again.

## Delivery guarantees

- **At-least-once**. A republished event may reach a consumer twice (for example if the process
  dies after the publish but before the commit). Every consumer deduplicates by `eventId`, and a
  retry never changes it.
- The republished event has the same fields, values and `eventId` as the original. Key order in
  the JSON may differ, because PostgreSQL `jsonb` doesn't keep it.
- A projection retry while MongoDB is down is a transient failure: the row waits and resolves
  once MongoDB is back.
- **Kafka down at startup or deploy**: the service still starts, because the producer connects
  lazily on first publish. Each publish attempt while Kafka is down gives up within about 3 s
  (`KAFKA_CONNECTION_TIMEOUT_MS`, `KAFKA_PRODUCER_RETRIES`), so the client still gets its
  `201`/`200` and the event lands here as `PENDING_RETRY`. The worker's own republish attempts
  fail just as quickly, and the first one after Kafka recovers reconnects the producer.
- **Remaining gap**: if the process dies between the DB commit and the first publish attempt,
  the event is never dead-lettered. Closing that needs a transactional outbox (out of scope).

## Inspecting the stores

```sql
-- What is waiting, and when it is next due
SELECT id, topic, "eventId", "retryCount", "nextRetryAt", "lastError"
  FROM order_dead_letters WHERE status = 'PENDING_RETRY' ORDER BY "nextRetryAt";

-- Inbound rows that need a human
SELECT id, topic, "failureType", "orderId", "retryCount", "lastError", error, "rawValue"
  FROM consumed_message_dead_letters WHERE status = 'EXHAUSTED' ORDER BY "createdAt" DESC;

-- Overview
SELECT 'outbound' AS store, status, count(*) FROM order_dead_letters GROUP BY status
UNION ALL
SELECT 'inbound', status, count(*) FROM consumed_message_dead_letters GROUP BY status;
```

To retry an `EXHAUSTED` row by hand after fixing its cause:
`UPDATE … SET status = 'PENDING_RETRY', "retryCount" = 0, "nextRetryAt" = now() WHERE id = …`.

## Out of scope

No admin API or UI, no manual replay or purge endpoint, no alerting and no metrics. Exhausted
rows are visible only through the error log and SQL.
