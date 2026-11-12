# 0005. Dead-letter retry: per-row transactions with SKIP LOCKED and a self-rescheduling worker

- **Status**: Accepted
- **Date**: 2026-11-12

## Context

The write flow saves to PostgreSQL first and publishes to Kafka second. A failed publish
is stored in `order_dead_letters`, and the request still succeeds. Consumers dead-letter messages
they cannot process to `consumed_message_dead_letters`. Until US-08 nothing replayed either
table, so a broker or database outage lost events until someone acted by hand.

The retry mechanism must:
- run in every instance without two instances processing the same row;
- survive a crash mid-attempt;
- never overlap its own cycles;
- never block startup or shutdown;
- keep the original `eventId`, because consumers deduplicate on it.

An attempt can be slow: with Kafka down, one publish waits for the producer's own retry
timeout.

## Decision

We will:

1. **Claim one row per transaction** with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`, process it
   while the lock is held, write the outcome and commit (`processNextDue` on the existing
   repositories). We use **no lease**: a crash rolls the transaction back and the row is due
   again at once. We rejected claiming a batch under a lease, because the lease would have to
   outlast the worst-case batch time (20 publishes × the producer timeout), which is fragile to
   choose.
2. **Schedule with a self-rescheduling `setTimeout`** in `DeadLetterRetryWorker`
   (`src/infra/dead-letter/`), started in `onApplicationBootstrap` and stopped in
   `onModuleDestroy`. Each cycle schedules the next one only when it ends, so cycles cannot
   overlap. We rejected `@nestjs/schedule`: it is a new dependency, it still needs a re-entrancy
   guard, and it needs extra wiring for a configurable interval. We rejected `setInterval`
   because it overlaps slow cycles.
3. **Reuse, not duplicate**:
   - outbound rows are republished through `OrderEventsProducer.republish` (stored payload, same
     `eventId`, key = `aggregateId`);
   - inbound rows go through the owning consumer's `process()`, which is the same parse and
     handle as live consumption, so idempotency is unchanged.
4. **Decide with a pure policy** (`retry-policy.ts`): success → `RESOLVED`; permanent failure →
   `EXHAUSTED`; transient failure → `min(base × 2^(n−1), max)` backoff, with no jitter, until
   `maxRetries`, then `EXHAUSTED` and an error log.
5. Accept **at-least-once** delivery.

## Consequences

- Several instances retry safely together, and nothing needs tuning for crash recovery.
- Each worker holds at most one row lock and one pooled connection while an attempt runs.
- Throughput is one row per transaction. That is fine for dead letters, which are rare.
- Retry rules are unit-tested without timers or databases. Inbound retries can't drift from
  live consumption, because both use the same `process()`.
- Consumers may see an event twice. They already deduplicate by `eventId`.
- A republished payload may differ in JSON key order (`jsonb`), but not in content.
- `enableShutdownHooks()` is now on in `main.ts`, so `onModuleDestroy` runs on SIGTERM.
- **Follow-ups**:
  - a transactional outbox, to close the gap where a crash between the DB commit and the first
    publish loses the event before it is dead-lettered;
  - an admin API or replay, purge of final rows, and alerting on exhaustion.
