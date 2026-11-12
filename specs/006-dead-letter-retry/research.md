# Research: Dead-Letter Retry (US-08)

Phase 0 output for [plan.md](plan.md). Facts were checked against current `main` (US-07 merged):
- `@nestjs/schedule` is **not** installed;
- `main.ts` does **not** call `enableShutdownHooks()`;
- `order_dead_letters` already has `retryCount int default 0` and stores the full event in a
  `payload jsonb` column;
- `consumed_message_dead_letters` has `failureType` (`MALFORMED` / `RETRIES_EXHAUSTED`),
  `attempts`, and `rawValue text`;
- the local data has 0 outbound rows, 2 `MALFORMED` rows and 1 `RETRIES_EXHAUSTED` row.

---

## R1. Scheduling: a self-rescheduling timer (no `@nestjs/schedule`)

**Decision** (the user asked for this choice to be recorded): no new dependency. Use a
**self-rescheduling `setTimeout`** owned by `DeadLetterRetryWorker`
(`src/infra/dead-letter/dead-letter-retry.worker.ts`):
- `onApplicationBootstrap()` schedules the first cycle after `intervalMs`, unless the worker is
  disabled. It never awaits a cycle, so startup is not delayed (FR-005).
- Each cycle runs to completion, then schedules the next one. Cycles therefore **cannot overlap**
  (FR-005).
- `onModuleDestroy()` sets `stopping`, clears the pending timer, and awaits the in-flight cycle.
  The cycle checks `stopping` before claiming each row, so shutdown waits for at most one
  in-flight attempt (SC-006).
- Timers are `unref()`'d, so they never keep the process alive.

`onApplicationBootstrap` is used instead of the user's suggested `onModuleInit`, so that the
producer, the consumers and the TypeORM connection are fully initialised before the first cycle.
It also matches the existing consumers.

**Alternatives considered**:
- `@nestjs/schedule` with `@Interval()`: adds a dependency, and overlap prevention would still need
  a re-entrancy flag. The interval also has to be configurable at runtime, which needs
  `SchedulerRegistry` plumbing.
- A plain `setInterval`: it can fire while a slow cycle is still running (for example while Kafka
  is down and each publish times out), so cycles would overlap.

---

## R2. Claiming: one row per transaction with `FOR UPDATE SKIP LOCKED`, lock held while processing

**Decision**: Process each row inside its **own** transaction, on a dedicated query runner:

```sql
BEGIN;
SELECT * FROM order_dead_letters
 WHERE status = 'PENDING_RETRY' AND "nextRetryAt" <= now()
 ORDER BY "nextRetryAt", "createdAt"
 LIMIT 1
 FOR UPDATE SKIP LOCKED;
-- process the row (publish / re-handle) while it stays locked
UPDATE order_dead_letters SET status = …, "retryCount" = …, "nextRetryAt" = …, … WHERE id = …;
COMMIT;
```

The worker repeats this up to `batchSize` times per store per cycle.

**Rationale**:
- **Exclusivity** (FR-012): a locked row is invisible to other claimers (`SKIP LOCKED`), so they
  take the next due row instead of waiting.
- **Crash safety without a lease** (FR-013): if the worker or process dies, or the connection
  drops, Postgres rolls the transaction back and releases the lock. The row is immediately due
  again, so no expiry bookkeeping is needed. This replaces the "claim lease" the spec left open.
- **No double processing in a cycle**: after a failure `nextRetryAt` moves into the future; after
  a success the status becomes final.
- **Short locks**: one row at a time. The longest a lock is held is one publish attempt, bounded
  by the producer's own timeout.

**Trade-off**: one Postgres connection is held per worker during each attempt (the pool default is
10). Acceptable: at most one per instance.

**Alternatives considered**:
- Claim a batch, then commit with a lease (`nextRetryAt = now + lease`) and process outside the
  transaction. This needs a lease length longer than the worst-case batch time: with Kafka down,
  20 publishes × the producer's retry timeout can exceed several minutes. Choosing that number is
  fragile.
- Hold the transaction for the whole batch: it keeps 20 rows locked across slow publishes.

---

## R3. Retry decision: a pure function, unit-tested with fake time

**Decision**: `decideRetry(row, attempt, now, settings)` in `src/infra/dead-letter/retry-policy.ts`
returns the update to apply. It covers:

| Attempt result | Update |
|---|---|
| success | `status RESOLVED`, `resolvedAt = now`, `lastAttemptAt = now`, `lastError = null` |
| permanent failure (malformed) | `status EXHAUSTED`, `retryCount + 1`, `lastError`, `lastAttemptAt = now` |
| transient failure, `retryCount + 1 < maxRetries` | stays `PENDING_RETRY`, `retryCount + 1`, `nextRetryAt = now + deadLetterDelay(retryCount + 1)`, `lastError`, `lastAttemptAt` |
| transient failure, `retryCount + 1 ≥ maxRetries` | `status EXHAUSTED`, `retryCount + 1`, `lastError`, `lastAttemptAt` (and an error is logged) |

`deadLetterDelay(n) = min(baseDelayMs × 2^(n−1), maxDelayMs)`, with no jitter (spec assumption).

**Rationale**: all the branching rules (FR-008, FR-010, FR-011) sit in one deterministic function
that is tested without databases or timers. The worker only orchestrates.

---

## R4. Outbound republish through `OrderEventsProducer`

**Decision**: add `republish(topic: string, payload: Record<string, unknown>): Promise<void>` to
the existing `OrderEventsProducer`. It sends one message with `key = payload.aggregateId` and
`value = JSON.stringify(payload)`. The worker validates first that:
- the topic is one of `ORDER_PLACED/CONFIRMED/CANCELLED_TOPIC`;
- the payload has string `eventId` and `aggregateId`.

A row that fails this validation is malformed and becomes `EXHAUSTED`.

**Correction to the spec's wording**: FR-006 says "byte-for-byte the same event". The payload is
stored as `jsonb`, and **Postgres does not preserve key order in `jsonb`**. The republished JSON
therefore has the same fields, values and `eventId`, but possibly a different key order.
Consumers parse JSON, so this has no functional effect. FR-006 is amended to "the same event (same
fields, values and event id)".

**Alternatives considered**: reconstructing the event from the order row. That would need a
write-model read, could produce a different `occurredAt`, and is unnecessary because the stored
payload is the event.

---

## R5. Inbound re-handling: reuse the consumers' own parse + handle (no duplication)

**Decision**: each consumer gets a public `process(topic, value: Buffer | null): Promise<void>`
method:
- `PaymentEventsConsumer.process`: `parsePaymentMessage`, then
  `commandBus.execute(ReactToPaymentOutcomeCommand)`;
- `OrderProjectionConsumer.process`: `parseOrderEventMessage`, then
  `OrderProjectionService.project`.

Their existing `handleMessage` passes these same steps to `consumeWithDeadLetter`, so live
consumption and retry share one implementation. Both consumers expose `topics`, and the worker
routes an inbound row to the consumer whose topics include `row.topic`. An unknown topic is
treated as malformed and becomes `EXHAUSTED`.

The worker calls `process` **directly**, not through `consumeWithDeadLetter`, so a failed retry
never creates a new dead letter and never commits a Kafka offset (FR-009). `MalformedMessageError`
from parsing is a permanent failure (FR-008). Anything else is transient, including
`ReadModelUnavailableError`, `OrderNotFoundForPaymentError` and an outbound publish failure.

Idempotency is unchanged (FR-007):
- payment outcomes are deduplicated by `eventId` in `processed_events` (US-04);
- the projection is deduplicated by `appliedEventIds` (US-05).

A duplicate counts as **success**, so the row is resolved.

---

## R6. Schema change: one migration

**Decision**: `AddDeadLetterRetryBookkeeping<ts>`:
- `CREATE TYPE dead_letter_status_enum AS ENUM ('PENDING_RETRY','RESOLVED','EXHAUSTED')`;
- both tables get `status dead_letter_status_enum NOT NULL DEFAULT 'PENDING_RETRY'`,
  `"nextRetryAt" timestamptz NOT NULL DEFAULT now()`, `"lastAttemptAt" timestamptz NULL`,
  `"lastError" text NULL` and `"resolvedAt" timestamptz NULL`;
- `consumed_message_dead_letters` also gets `"retryCount" int NOT NULL DEFAULT 0`
  (`order_dead_letters` already has it);
- backfill: `UPDATE consumed_message_dead_letters SET status = 'EXHAUSTED' WHERE "failureType" =
  'MALFORMED'` (FR-003). Every other existing row gets the column defaults: `PENDING_RETRY`, due
  now;
- partial indexes for the claim query:
  `IDX_order_dead_letters_due ON order_dead_letters ("nextRetryAt", "createdAt") WHERE status = 'PENDING_RETRY'`,
  and likewise `IDX_consumed_dead_letters_due`;
- `down()` drops the indexes, columns and type.

The existing `retryCount` on `order_dead_letters` (always 0 so far) is reused as the worker's
retry count. The consumed table's `attempts` keeps its meaning: attempts made **inside the
consumer** before dead-lettering.

---

## R7. Creating rows with the right initial status

**Decision**:
- `OrderDeadLetterRepository.recordFailure`: unchanged apart from relying on the defaults
  (`PENDING_RETRY`, due now).
- `ConsumedMessageDeadLetterRepository.recordRetriesExhausted`: defaults (`PENDING_RETRY`).
- `ConsumedMessageDeadLetterRepository.recordMalformed`: inserts with `status: EXHAUSTED` (FR-002).

The claim and update methods are added to these **same repositories**, as the user asked:
`processNextDue(handler)` runs the R2 transaction, gives the handler a typed row and applies the
handler's returned `RetryUpdate`.

---

## R8. Clean shutdown in production: `enableShutdownHooks()`

**Finding**: without `app.enableShutdownHooks()`, `SIGTERM`/`SIGINT` do not run
`onModuleDestroy`/`onApplicationShutdown`. Today that means the Kafka consumers are not
disconnected gracefully either.

**Decision**: call `app.enableShutdownHooks()` in `configureApp` (`src/app.setup.ts`), so FR-005 holds
in production and not only in tests (where `app.close()` runs the hooks). This is a one-line,
behaviour-improving change. Even without a clean stop, R2 keeps the data safe: a killed process
releases its row locks.

---

## R9. Configuration

`src/config/configuration.ts` gains `deadLetter: { enabled, intervalMs, batchSize, baseDelayMs,
maxDelayMs, maxRetries }`:

| Env var | Default |
|---|---|
| `DEAD_LETTER_RETRY_ENABLED` | `true` (`"false"` disables) |
| `DEAD_LETTER_RETRY_INTERVAL_MS` | `30000` |
| `DEAD_LETTER_BATCH_SIZE` | `20` (per store, per cycle) |
| `DEAD_LETTER_BASE_DELAY_MS` | `5000` |
| `DEAD_LETTER_MAX_DELAY_MS` | `600000` |
| `DEAD_LETTER_MAX_RETRIES` | `8` |

All of these are listed in `.env.example`.

---

## R10. Testing approach

- **Unit**:
  - `retry-policy.spec.ts`: `deadLetterDelay` schedule (5s, 10s, 20s, …, capped) and `decideRetry`
    for every row of the R3 table, at the max boundary and with fake `now`;
  - `dead-letter-retry.worker.spec.ts` with Jest fake timers and mocked repositories and
    handlers:
    - cycles never overlap;
    - the first cycle runs after one interval and startup does not wait;
    - batch size is respected per store;
    - outbound validation (bad topic or payload → `EXHAUSTED`);
    - inbound routing by topic, and an unknown topic → `EXHAUSTED`;
    - malformed → `EXHAUSTED`;
    - an exhaustion logs an error with full context;
    - `onModuleDestroy` waits for the in-flight attempt and starts nothing new;
    - disabled → no cycles;
  - consumer `process()` unit tests, and the existing consumer suites stay green.
- **Integration (PostgreSQL container)** `dead-letter.repository.integration.spec.ts`:
  - only due `PENDING_RETRY` rows are claimed, oldest `nextRetryAt` first;
  - the update is applied in the same transaction;
  - two concurrent `processNextDue` calls whose handlers wait on a barrier receive **different**
    rows, and a third call finds none while both are held;
  - a handler that throws rolls back, so the row is unchanged and due again;
  - the migration backfill: a `MALFORMED` row becomes `EXHAUSTED` and the others
    `PENDING_RETRY`.
- **Component (Kafka + PostgreSQL)** `dead-letter-retry.component.spec.ts`, with the worker at a
  200 ms interval:
  - (a) `producer.send` is stubbed to fail once, then `POST /orders` → a `PENDING_RETRY` row;
    with `send` restored, within a few intervals the row is `RESOLVED` and the observer receives
    `OrderPlaced` with the **same** `eventId`;
  - (b) insert an inbound row (`payments.payment-processed` raw value for an existing `PENDING`
    order) → the order becomes `CONFIRMED` and the row `RESOLVED`;
  - (c) an inbound row for a non-existent order with `DEAD_LETTER_MAX_RETRIES=2` and small delays
    → `EXHAUSTED` after 2 retries.

  Topics are created with `createTopicsWhenReady` (US-07 fix).
