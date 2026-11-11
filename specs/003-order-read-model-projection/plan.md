# Implementation Plan: Order Read Model Projection (US-05)

**Branch**: `feature/US-05-order-read-model-projection` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-order-read-model-projection/spec.md`, plus the
user's planning directions: read model in `src/read-model/` (Mongoose schema and
`OrderViewRepository`); the projection consumer in `src/infra/kafka/` calling a projection
service; reuse US-04's retry helper and dead-letter repository; a `ReadModelModule` with
`MongooseModule.forRootAsync` reading `MONGO_URI`.

## Summary

Add a second Kafka consumer, `OrderProjectionConsumer`, in its own group
(`KAFKA_PROJECTION_GROUP_ID`), starting from the earliest offset. It projects `orders.order-placed`,
`orders.order-confirmed` and `orders.order-cancelled` into one MongoDB document per order in
`order_views`.

- **Rules**: a pure, read-side projector (`projectOrderEvent`). It is order-independent,
  idempotent through `appliedEventIds` stored on the document, keeps terminal statuses, resolves
  conflicting terminals by "earliest wins", and is fully deterministic (`updatedAt` = latest event
  time). This makes replays reproduce identical documents.
- **Persistence**: `OrderViewRepository` writes whole documents with optimistic concurrency on a
  `revision` field, so applying an event and recording its id is one atomic write.
- **Failures**: US-04's parse → retry → dead-letter → commit flow is extracted into a shared helper
  that both consumers use. A MongoDB outage is the one failure that is redelivered rather than
  dead-lettered.
- **Startup**: MongoDB connects lazily, so its absence never blocks the HTTP API or the payment
  consumer.

Rationale is in [research.md](research.md) R1–R10.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `kafkajs` 2.2.4, TypeORM 0.3 (dead letters
only). New: `@nestjs/mongoose@^10.1.0` and `mongoose@^8` (runtime), `@testcontainers/mongodb@10.28.0`
(dev).

**Storage**: MongoDB 7 for the read model (`order_views`). PostgreSQL only for the existing
`consumed_message_dead_letters` table; no migration.

**Testing**: Jest, `@nestjs/testing`, Supertest, testcontainers (PostgreSQL, Kafka and the new
MongoDB).

**Target Platform**: Linux container / local Node against `ecommerce-infra` (`mongo:7` on `:27017`).

**Project Type**: Web service (single NestJS project).

**Performance Goals**: A view appears ≤ 5s after `POST /orders` and reflects the payment outcome
≤ 5s later (SC-001). Volume is low.

**Constraints**:
- Commit offsets only after the Mongo write (or the dead-letter write).
- Deterministic documents (replay gives identical documents).
- No writes or reads to PostgreSQL apart from dead letters.
- No shared classes with the write side.
- MongoDB down must not affect HTTP or the payment consumer.
- Kafka retention is 7 days, which bounds backfill (spec assumption).

**Scale/Scope**: One new module, one new consumer, about 15 new source files, one refactor of
the US-04 consumer into a shared helper.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Gate | Status |
|---|---|---|
| I. Layering | Consumer (inbound adapter, I/O and DTO validation only) → `OrderProjectionService` (orchestration: load, project, save) → `projectOrderEvent` (pure rules) → `OrderViewRepository` (persistence). No rules in the consumer or the service. | ✅ |
| II. CQRS separation | The read model lives in MongoDB and is populated only by the projection consuming Kafka events. Read-side types (`OrderView`, schema, message DTOs, `OrderViewStatus`) are separate from the TypeORM entities and the `Order` aggregate. A test asserts that `OrderViewStatus` values equal `OrderStatus` without importing across paths in source. No GraphQL yet (US-06/07). | ✅ |
| III. Write flow | Unchanged. The projection never touches the write path. | ✅ (n/a) |
| IV. Type safety & validation | Consumed messages are validated with `class-validator` DTOs (R9). No `any`. Errors are typed (`MalformedMessageError`, `OrderViewConcurrencyError`, `ReadModelUnavailableError`); none reach HTTP. Every message ends applied, duplicate, dead-lettered, or redelivered; nothing fails silently. | ✅ |
| V. Test coverage | The projector, service, parser, helper and consumer have unit tests (happy and edge cases). `src/read-model/**` is added to the 80% coverage threshold. | ✅ |
| VI. Testing strategy | Unit, plus integration with a real MongoDB container, plus a component test with real Kafka, PostgreSQL and MongoDB. | ✅ |
| VII. Kafka | Consumes its own `orders.*` events. Idempotent by `eventId`. Commits after the DB save. Backoff then dead-letter. The one deviation: a read-model **outage** is redelivered instead of dead-lettered (R6). This is still "retry"; it avoids dead-lettering healthy events, and the spec was amended (FR-017). | ✅ (documented) |
| VIII. Branching | On `feature/US-05-order-read-model-projection`, created from an up-to-date, clean `main` before the spec. Conventional Commits scoped `US-05`. | ✅ |
| IX. Build & quality | The four-step gate runs after every task. | ✅ (process) |
| Tech stack | MongoDB via `@nestjs/mongoose` and testcontainers for MongoDB are already listed in v1.1.0. | ✅ |
| Docs | Add `docs/read-model.md`. Update `README.md`, `CLAUDE.md`, `src/README.md` and the event docs' "Consumers" sections. Add **ADR 0004** (projection consistency strategy: order-independent merge, per-document dedupe, deterministic timestamps, outage vs poison handling) and index it. JSDoc on all public classes. | ✅ |

**Post-design re-check (after Phase 1)**: still passes. The data model keeps the read side
self-contained. The only cross-path dependency is the dead-letter repository, which is
infrastructure for consumed messages and not a write-model entity, as the user asked. The helper
extraction changes US-04 code without changing its behaviour, and US-04's tests guard it.
Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-order-read-model-projection/
├── spec.md                       # amended in planning: null-for-unknown, outage ≠ dead-letter
├── plan.md                       # this file
├── research.md                   # R1–R10
├── data-model.md                 # document shape, read-side types, projection rules, config
├── quickstart.md                 # live validation, rebuild/replay, failure scenarios
├── contracts/
│   ├── order-view-document.md    # contract for US-06/07 readers
│   └── consumed-order-events.md  # what the projection requires from orders.* events
├── checklists/requirements.md
└── tasks.md                      # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

New files are marked `+`, changed files `~`.

```text
src/
├── app.module.ts                               ~ import ReadModelModule
├── config/configuration.ts                     ~ readModel.mongoUri; kafka.projectionGroupId
├── read-model/                                 + read side (never imports src/domain or src/infra/database/entities)
│   ├── read-model.module.ts                    + MongooseModule.forRootAsync (MONGO_URI, lazyConnection, bufferCommands:false) + forFeature
│   ├── order-view-status.enum.ts               + PENDING | CONFIRMED | CANCELLED (same values as OrderStatus)
│   ├── order-view.ts                           + OrderView, OrderItemView, StoredOrderView types
│   ├── order-event.ts                          + OrderEvent discriminated union
│   ├── order-view.projector.ts                 + projectOrderEvent (pure rules)
│   ├── order-view.schema.ts                    + Mongoose schema → order_views
│   ├── order-view.repository.ts                + findById / insert / replace (revision), Mongo error mapping
│   ├── order-projection.service.ts             + load → project → save; logs warnings
│   ├── errors.ts                               + OrderViewConcurrencyError, ReadModelUnavailableError
│   └── messages/                               + OrderPlaced/Confirmed/CancelledMessageDto (+ item DTO)
├── infra/kafka/
│   ├── malformed-message.error.ts              + base MalformedMessageError
│   ├── payment-message.parser.ts               ~ MalformedPaymentMessageError extends MalformedMessageError
│   ├── consume-with-dead-letter.ts             + shared parse → retry → dead-letter|fatal → commit flow
│   ├── payment-events.consumer.ts              ~ uses consumeWithDeadLetter (behaviour unchanged)
│   ├── order-event-message.parser.ts           + raw → DTO → OrderEvent | MalformedMessageError
│   └── order-projection.consumer.ts            + group KAFKA_PROJECTION_GROUP_ID, 3 topics, fromBeginning
└── README.md                                   ~ read-model folder + projection flow

tests/
├── unit/read-model/{order-view.projector,order-projection.service,order-view-status}.spec.ts  +
├── unit/infra/{order-event-message.parser,consume-with-dead-letter,order-projection.consumer}.spec.ts +
├── integration/{order-view.repository,order-projection}.integration.spec.ts                 +
└── component/order-projection.component.spec.ts                                             +

docs/read-model.md                                   +
docs/adr/0004-read-model-projection-consistency.md   +
docs/adr/README.md, docs/events/*.md, README.md, CLAUDE.md, .env.example, package.json, jest.config.js   ~
```

**Structure Decision**: Follow the user's directions. The whole read side lives in
`src/read-model/`, a vertical slice that is deliberately separate from the layer-first write side,
which makes the CQRS boundary visible in the tree. The Kafka adapter stays in `src/infra/kafka/`
with the payment consumer. `ReadModelModule` is the first feature module. `AppModule` imports it
instead of growing its own provider list further.

## Follow-ups (out of scope, recorded)

- A rebuild-from-PostgreSQL job (or compacted or longer retention) for orders older than Kafka's
  7-day window.
- Per-consumer enable switches and retry settings (both consumers currently share
  `KAFKA_CONSUMER_ENABLED` and `PAYMENT_CONSUMER_*`).
- Query indexes on `order_views` (with US-06/07).
- A readiness or health endpoint reporting projection lag and MongoDB connectivity.

## Complexity Tracking

None. No constitution violations to justify.
