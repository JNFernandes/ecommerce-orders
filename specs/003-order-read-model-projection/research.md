# Research: Order Read Model Projection (US-05)

Phase 0 output for [plan.md](plan.md). Each entry records **Decision / Rationale / Alternatives
considered**. Versions were checked against the npm registry and the installed tree, and the local
stack against `../ecommerce-infra/docker-compose.yml`.

---

## R1. Dependencies and versions

**Decision**:
- `@nestjs/mongoose@^10.1.0`. Its peers are `@nestjs/common` / `@nestjs/core` `^10` (installed:
  10.4.22) and `mongoose ^6 || ^7 || ^8`. Released 2024-10.
- `mongoose@^8`, the latest major allowed by that peer range.
- `@testcontainers/mongodb@10.28.0` (dev). It matches the installed `testcontainers@10.28.0`
  exactly, so both share one Docker client and one Ryuk instance.
- Test image `mongo:7`, the same as `ecommerce-infra`.

**Rationale**: These are the versions the user named, and they are compatible with the existing
NestJS 10 stack. No other new runtime dependency is needed (Constitution tech-stack rule: MongoDB
via `@nestjs/mongoose` is already listed).

**Alternatives considered**: the plain `mongodb` driver without Mongoose. It is lighter, but the
user and the constitution specify `@nestjs/mongoose`.

---

## R2. Where the projection rules live (layering)

**Decision**: A pure function,
`projectOrderEvent(current: OrderView | null, event: OrderEvent): ProjectionResult`, in
`src/read-model/order-view.projector.ts`. It returns either `{ kind: 'unchanged' }` (a duplicate)
or `{ kind: 'changed', view, warnings }`. It has no I/O and no framework dependency. The chain is:

`OrderProjectionConsumer` (inbound adapter, `src/infra/kafka/`)
→ `OrderProjectionService` (orchestration, `src/read-model/`: load, project, save)
→ `projectOrderEvent` (read-side rules)
→ `OrderViewRepository` (Mongo persistence, `src/read-model/`).

**Rationale**: Principle I: rules live in a pure, unit-testable unit, not in the consumer or the
service. Principle II: the read side gets its own rules module and must not reuse the write-side
`Order` aggregate. That aggregate models write invariants (for example, "only PENDING can be
confirmed") which a projection must *not* enforce, because events can arrive out of order. All
out-of-order and duplicate cases (spec US2/US3) become table-driven unit tests of one function.

**Alternatives considered**:
- *Encode the rules in a single MongoDB aggregation-pipeline update* (`$cond` / `$in` inside
  `findOneAndUpdate`): atomic, but the rules would be hard to read and impossible to unit-test
  without a database.
- *Route through the `@nestjs/cqrs` EventBus or CommandBus*: a projection is neither a command
  (it changes no write state) nor a query. Calling the service directly, as the user asked, is
  simpler and does not blur Principle II.

---

## R3. Atomic "apply and record eventId" (FR-012, FR-013): optimistic concurrency

**Decision**: Read, project in memory, then write the **whole document** conditionally:
- **New view**: `insertOne` with `revision: 1`. Mongo duplicate-key error `11000` means another
  writer created it first, so throw `OrderViewConcurrencyError` (retryable).
- **Existing view**: `replaceOne({ _id, revision: expected }, { ...view, revision: expected + 1 })`.
  `matchedCount === 0` means another writer won, so throw `OrderViewConcurrencyError` (retryable).
  On retry the document is re-read, and the event is either applied to the fresh state or
  recognised as a duplicate.

`appliedEventIds` is part of the same document, so applying the change and recording the event
id is a single atomic write by construction.

**Rationale**: Only one consumer instance processes a partition at a time, but the three topics
are separate partitions. With more than one instance, `OrderPlaced` and `OrderConfirmed` for the
same order can be processed concurrently, and the revision check makes that safe without locks.
A conflict reuses the existing retry path (R6).

**Alternatives considered**: `findOneAndUpdate` with `$addToSet` plus field updates. That cannot
express "keep the terminal status" or "earliest terminal wins" without the pipeline-update
complexity from R2. Transactions are unnecessary for a single document.

---

## R4. Deterministic documents (FR-006, FR-011, FR-015)

**Decision**:
- `updatedAt` = max(`occurredAt`) over the applied events, never `new Date()`.
- `appliedEventIds` is kept **sorted** (lexicographically), so its content does not depend on
  arrival order.
- `revision` is equal to the number of applied events, so it is also independent of order.
- Conflicting terminal events (both confirmed and cancelled): the earliest `occurredAt` wins,
  ties are broken by the smaller `eventId`, and the winner's id is stored as `statusEventId`, so a
  later event can be compared against it. The loser's timestamp and reason are not stored, and a
  warning is logged.
- Item subtotal = `Math.round(quantity × unitPrice × 100) / 100`. This matches the write-side
  rounding in `Order.place`.
- All fields are always present, with `null` when unknown, so every document has the same shape
  (the spec was updated to say this).

**Rationale**: The acceptance criterion "resetting the consumer group and replaying produces
identical documents" holds trivially when documents already exist (every event is a duplicate).
It also holds when rebuilding into an empty collection, because nothing depends on wall-clock
time or arrival order.

**Alternatives considered**: storing a projection timestamp as `updatedAt`. That would be useful
for operations, but it breaks the identical-documents criterion. If one is ever needed, it can be
added as a separate field, `projectedAt`, that is excluded from equality.

---

## R5. Connection behaviour (FR-021): never block the HTTP API on MongoDB

**Decision**: `MongooseModule.forRootAsync` reads `MONGO_URI` from `ConfigService` and sets:
- `lazyConnection: true` (supported by `@nestjs/mongoose@10.1`), so bootstrap does not wait for
  MongoDB;
- `bufferCommands: false`, so an operation while disconnected fails fast instead of hanging for
  10s;
- `serverSelectionTimeoutMS: 5000`.

**Rationale**: Without `lazyConnection`, Nest awaits the connection (and retries 9 times, 3s
apart) before `app.listen`, so a MongoDB outage would take down the HTTP API and the payment
consumer, which violates FR-021. With fail-fast operations, outage handling is explicit (R6).

**Alternatives considered**: a separate Nest application or process for the projection. That
gives isolation, but it is a second deployable, which is overkill and against ADR 0001's "one
deployable" intent.

---

## R6. Failure classification: poison message vs read-model outage

**Decision**: Three classes, handled by the shared consumer helper (R7):

| Error | Retry | After retries |
|---|---|---|
| `MalformedMessageError` (parse or validation) | no | dead-letter `MALFORMED`, commit |
| `ReadModelUnavailableError` (Mongo network or server-selection errors, or "not connected" with `bufferCommands: false`) | yes, with backoff | **throw** (no dead letter, no commit), so kafkajs restarts the consumer from the last committed offset and redelivers |
| anything else (for example `OrderViewConcurrencyError`, unexpected errors) | yes, with backoff | dead-letter `RETRIES_EXHAUSTED`, commit |

The repository translates driver errors into `ReadModelUnavailableError`, so callers never
inspect Mongo internals.

**Rationale**: Dead-lettering is for poison messages. If an outage dead-lettered every event, the
read model would be left with holes that only US-08 could repair, while Kafka already keeps the
events for 7 days. The spec's FR-017 was amended during planning to say this. The US-04 payment
consumer has the same property implicitly: if Postgres is down, the dead-letter write fails and
nothing is committed.

**Alternatives considered**: pausing the partition with `consumer.pause()` until Mongo is
reachable. It is more precise, but needs a health poller. kafkajs's restart-from-committed-offset
gives the same outcome for free.

---

## R7. Reusing US-04's retry and dead-letter mechanics without duplication

**Decision**:
- Extract the parse → retry → dead-letter → commit flow from `PaymentEventsConsumer.handleMessage`
  into one helper, `src/infra/kafka/consume-with-dead-letter.ts`:
  `consumeWithDeadLetter<T>(payload, { parse, handle, isFatal, deadLetters, retry, commit, logger })`.
- `isFatal(error)` marks errors that propagate after retries instead of being dead-lettered.
  It returns false for payments, so their behaviour is unchanged, and matches
  `ReadModelUnavailableError` for the projection.
- Introduce `MalformedMessageError` (`src/infra/kafka/malformed-message.error.ts`) as the base
  class. The existing `MalformedPaymentMessageError` now extends it, so its name and fields are
  unchanged.
- Both consumers use the helper. US-04's unit, integration and component tests are the
  regression net for the refactor.
- The retry settings stay `PAYMENT_CONSUMER_MAX_ATTEMPTS` / `_BACKOFF_INITIAL_MS` / `_BACKOFF_MAX_MS`
  and now apply to both consumers (documented). Renaming them would break existing `.env` files
  for no functional gain.

**Rationale**: This is the user's instruction ("reuse the retry-with-backoff helper and the
consumed-message dead-letter repository"). A second, copy-pasted `handleMessage` would drift.

**Alternatives considered**: copying the logic into the new consumer (rejected: duplication); a
generic base-class consumer (inheritance hides the flow, and a function is easier to test).

---

## R8. Consumer wiring

**Decision**: `OrderProjectionConsumer` in `src/infra/kafka/order-projection.consumer.ts` mirrors
`PaymentEventsConsumer`:
- `kafka.consumer({ groupId: KAFKA_PROJECTION_GROUP_ID })`;
- subscribed to the three `orders.*` topics with `fromBeginning: true`;
- `autoCommit: false`, started in the background on bootstrap, and gated by the existing
  `KAFKA_CONSUMER_ENABLED`.

It is registered by `ReadModelModule`, which imports `MongooseModule` and provides
`OrderViewRepository`, `OrderProjectionService` and the consumer. `AppModule` imports
`ReadModelModule`.

**Rationale**: `fromBeginning: true` is what makes the first start a backfill (FR-002). A
separate group id means it keeps its own offsets, independent of the payment consumer
(FR-001).

**Note on ordering**: Orders publishes with `key = aggregateId`, so all events of one order on a
given topic go to the same partition, but the three topics are independent. That is why R2–R4
make the rules order-independent rather than relying on delivery order.

---

## R9. Message validation for the three order events

**Decision**: DTOs in `src/read-model/messages/`: `OrderPlacedMessageDto` (with a nested
`OrderPlacedItemMessageDto` validated through `@ValidateNested` + `@Type`),
`OrderConfirmedMessageDto` and `OrderCancelledMessageDto`. Rules per FR-016:
- `eventId`, `aggregateId`, `customerId`: `@IsUUID()`
- `occurredAt`: `@IsISO8601()`
- `version`: `@Equals(1)`
- `items`: `@IsArray() @ArrayMinSize(1)`, with each item's `quantity` `@IsInt() @Min(1)` and
  `unitPrice` `@IsNumber() @Min(0)`
- `totalAmount`: `@IsNumber() @Min(0)`
- `reason`: `@IsOptional() @IsString()`

The parser is `src/infra/kafka/order-event-message.parser.ts`, the counterpart of the payment
parser. Its output is a discriminated union, `OrderEvent`, defined in `src/read-model/`.

**Rationale**: Principle IV requires a validated DTO at every input boundary. Separate classes
from the write-side `OrderPlaced` / `OrderCancelled` domain events satisfy FR-019 (nothing shared
between paths), even though the JSON shape is the same.

---

## R10. Testing approach

**Decision**:
- **Unit**:
  - `projectOrderEvent` table tests: every event × every prior state, out-of-order pairs, both
    arrival orders giving equal documents, duplicates, conflicting terminals, reason
    null vs `""`, rounding;
  - `OrderProjectionService` with a mocked repository;
  - the parser;
  - `consumeWithDeadLetter`, including the new `isFatal` path;
  - the projection consumer wiring.
- **Integration** (real `MongoDBContainer('mongo:7')`):
  - `tests/integration/order-view.repository.integration.spec.ts`: insert, find, conditional
    replace, duplicate insert and stale revision giving `OrderViewConcurrencyError`, and outage
    mapping (stop the container, expect `ReadModelUnavailableError`).
  - `tests/integration/order-projection.integration.spec.ts`: `OrderProjectionService` plus the
    real repository. Apply placed→confirmed and confirmed→placed into two empty collections and
    assert the documents are deep-equal. Re-apply all events and assert nothing changed. Then
    "rebuild": drop the collection, replay the full event list, and compare it with the
    snapshot (FR-011, FR-015).
- **Component**: `tests/component/order-projection.component.spec.ts` with real Kafka, PostgreSQL
  and MongoDB containers and the full app modules plus `ReadModelModule`. Place an order through
  REST and poll Mongo for `PENDING` with items and total. Then confirm it
  (`POST /orders/:id/confirm`) and poll for `CONFIRMED` with `confirmedAt`. Also produce a
  malformed message on `orders.order-placed` and assert a `MALFORMED` dead letter, with
  projection continuing. A real consumer-group reset is checked manually in quickstart §3.
- **Coverage**: add `src/read-model/**/*.ts` (excluding `*.module.ts` and `*.schema.ts`) to
  `collectCoverageFrom`, with the same 80% threshold as domain and services (Principle V treats
  the projector as rules code).
- **US-04 regression**: the payment consumer's existing tests must pass unchanged after the R7
  refactor.

**Rationale**: Principles V and VI, and the user's explicit test list.
