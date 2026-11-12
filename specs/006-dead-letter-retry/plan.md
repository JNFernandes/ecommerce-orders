# Implementation Plan: Dead-Letter Retry (US-08)

**Branch**: `feature/US-08-dead-letter-retry` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-dead-letter-retry/spec.md`, plus the user's
planning directions:
- the worker lives in `src/infra/dead-letter/`, scheduled with `@nestjs/schedule` or a simple
  interval (the choice to be recorded);
- reuse `OrderEventsProducer`, the consumer handlers and the projection service;
- claim methods using `FOR UPDATE SKIP LOCKED` go in the existing dead-letter repositories;
- one TypeORM migration.

## Summary

Add retry bookkeeping to `order_dead_letters` and `consumed_message_dead_letters` in **one
migration**: status `PENDING_RETRY`/`RESOLVED`/`EXHAUSTED`, `retryCount`, `nextRetryAt`,
`lastAttemptAt`, `lastError` and `resolvedAt`. Existing `MALFORMED` rows are backfilled to
`EXHAUSTED`.

A `DeadLetterRetryWorker` in `src/infra/dead-letter/` runs on a **self-rescheduling timer**
(recorded choice: no `@nestjs/schedule`, research R1). It starts on application bootstrap without
blocking, never overlaps cycles, and stops cleanly on shutdown (`enableShutdownHooks()` is
added). Each cycle drains up to `DEAD_LETTER_BATCH_SIZE` due rows per store. Each row is handled
inside its **own transaction**, after `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` (via
`processNextDue` on the existing repositories). This gives exclusivity across instances and makes
a crash roll back to "due again", with no lease (R2).

- **Outbound** rows are republished through the existing `OrderEventsProducer` (new `republish`,
  key = `aggregateId`, the same `eventId`).
- **Inbound** rows go through the consumers' own parse-and-handle, extracted as `process()` and
  shared with live consumption, so duplicate protection is unchanged.

A pure `decideRetry` / `deadLetterDelay` policy decides resolved, reschedule (exponential, capped)
or exhausted, and the worker logs an error on exhaustion. Details: [research.md](research.md)
R1–R10.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node.js 20

**Primary Dependencies**: Unchanged: NestJS 10, TypeORM 0.3/PostgreSQL, kafkajs, `@nestjs/cqrs`,
Mongoose (read model). **No new dependencies** (no `@nestjs/schedule`).

**Storage**: PostgreSQL. One migration altering the two dead-letter tables: a new enum, 5–6
columns each, two partial indexes, and a backfill. MongoDB is untouched.

**Testing**: Jest (fake timers / injected clock), testcontainers PostgreSQL (claiming) and
Kafka + PostgreSQL (component).

**Target Platform / Project Type**: unchanged (NestJS service). The worker runs in every instance.

**Performance Goals**: An unpublished event goes out within two intervals of Kafka recovering
(SC-001). One row lock is held for at most one attempt.

**Constraints**: At-least-once delivery with an unchanged `eventId`. No overlapping cycles. No
startup delay. Shutdown waits for at most one attempt. Two workers never process the same row.
Retries never create new dead letters.

**Scale/Scope**: Low volume (dead letters are rare). Batch 20 per store per 30 s cycle.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Layering | The worker is infrastructure orchestration (claim → act → update). Retry rules live in the pure `retry-policy.ts`. Domain decisions for inbound messages stay in the existing handlers (`ReactToPaymentOutcomeService`, `projectOrderEvent`). Repositories only persist and claim. No business logic is added to controllers or services. | ✅ |
| II. CQRS | Outbound retries publish already-persisted events (no write-model change). Inbound retries reuse the existing command (payments) and projection (read side). The read-side boundary is unchanged: `src/read-model` gains no imports. | ✅ |
| III. Write flow | Untouched. Events are still published only after the DB save; the retry republishes saved events. The worker never publishes an event that was not first persisted. | ✅ |
| IV. Type safety | `RetryUpdate`, `AttemptResult` and `DeadLetterStatus` enum. Outbound payloads are validated (topic whitelist, string `eventId`/`aggregateId`) before republishing. No `any`. Every failure is classified and recorded; none is silent. | ✅ |
| V/VI. Tests | Unit (policy with fake time, worker with fake timers), integration (claiming on real PostgreSQL), component (real Kafka + PostgreSQL). | ✅ |
| VII. Kafka | "Failed events MUST be stored … for retry" is now fulfilled. Consumers stay idempotent. Retries never commit offsets or create new dead letters. At-least-once delivery with an unchanged `eventId`. | ✅ |
| VIII. Branching | `feature/US-08-dead-letter-retry` from an up-to-date `main`. Commits scoped `US-08`. | ✅ |
| IX. Quality gate | After every task. **Commit only when the gate exits 0** (`&&` chain). | ✅ (process) |
| Docs | `docs/dead-letter-retry.md`. ADR **0005** (retry design: per-row transaction with `SKIP LOCKED`, no lease, timer choice, at-least-once). README, `CLAUDE.md`, `docs/read-model.md`, `docs/events/*` and the US-04/05 notes that mention "retry is US-08" are updated. | ✅ |

**Post-design re-check**: still passes. Two small cross-cutting changes are justified in
research: `enableShutdownHooks()` (R8) and `process()` extracted from the consumers (R5, a
pure refactor guarded by the existing consumer tests). Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-dead-letter-retry/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/dead-letter-retry-behaviour.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

New files are marked `+`, changed files `~`.

```text
src/
├── app.setup.ts                                        ~ enableShutdownHooks()
├── app.module.ts                                       ~ register DeadLetterRetryWorker
├── config/configuration.ts                             ~ deadLetter settings
├── infra/
│   ├── dead-letter/
│   │   ├── retry-policy.ts                             + deadLetterDelay, decideRetry, types (pure)
│   │   └── dead-letter-retry.worker.ts                 + timer, cycles, outbound/inbound attempts, logging
│   ├── database/
│   │   ├── entities/dead-letter-status.enum.ts         + PENDING_RETRY | RESOLVED | EXHAUSTED
│   │   ├── entities/order-dead-letter.entity.ts        ~ status, nextRetryAt, lastAttemptAt, lastError, resolvedAt
│   │   ├── entities/consumed-message-dead-letter.entity.ts ~ same + retryCount
│   │   └── migrations/<ts>-AddDeadLetterRetryBookkeeping.ts + one migration (enum, columns, indexes, backfill)
│   └── kafka/
│       ├── order-events.producer.ts                    ~ republish(topic, payload)
│       ├── payment-events.consumer.ts                  ~ topics + process(); handleMessage uses it
│       └── order-projection.consumer.ts                ~ topics + process(); handleMessage uses it
└── repositories/
    ├── order-dead-letter.repository.ts                 ~ processNextDue(handler)
    └── consumed-message-dead-letter.repository.ts      ~ processNextDue(handler); recordMalformed → EXHAUSTED

tests/
├── unit/infra/retry-policy.spec.ts                     +
├── unit/infra/dead-letter-retry.worker.spec.ts         +
├── unit/infra/{payment-events,order-projection}.consumer.spec.ts ~ process()
├── integration/dead-letter.repository.integration.spec.ts +
└── component/dead-letter-retry.component.spec.ts       +

docs/dead-letter-retry.md                               +
docs/adr/0005-dead-letter-retry.md                      +
docs/adr/README.md, README.md, CLAUDE.md, docs/read-model.md, docs/events/*.md, .env.example ~
```

**Structure Decision**: The worker and its pure policy go in `src/infra/dead-letter/`, as
directed. Claiming lives in the existing repositories. Publishing and handling reuse the existing
producer and consumers. No new NestJS module: the worker is registered in `AppModule`, next to the
consumers it calls.

## Follow-ups (out of scope, recorded)

- Admin API or UI, manual replay and purge of `EXHAUSTED`/`RESOLVED` rows, alerting on
  exhaustion, metrics.
- A transactional outbox, to close the remaining gap where a crash between the DB commit and the
  first publish loses the event before it is even dead-lettered.

## Complexity Tracking

None.
