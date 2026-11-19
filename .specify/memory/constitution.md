<!--
SYNC IMPACT REPORT
==================
Version change:    1.2.0 → 1.3.0
Bump rationale:    MINOR — materially expanded guidance: one new consumed topic
                   (`identity.user-registered`) and the rule that Orders customers are created
                   from it. No principle removed, renamed or redefined.

Modified principles:
  - VII. Kafka Events (Producer & Consumers) — consumed topic `identity.user-registered`
    (published by ecommerce-identity) creates the Orders customer. Its `aggregateId` is the
    **user id** and MUST NOT be used as a customer id; the customer id is the `customerId` field
    and MUST be used as the Orders customer id. Customers are created only from this event
    (eventual consistency: an order placed before the customer exists is rejected, as today).
    Creating a customer that already exists is a no-op. Same consumer rules as the payment and
    stock consumers (dedupe by `eventId` in the same transaction as the customer insert, offsets
    committed after the PostgreSQL save, retry with backoff, then dead-letter).

Added sections:
  - (no new top-level sections)

Removed sections:
  - (none)

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates derive from this file at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; no mandatory section added or removed.
  ✅ .specify/templates/tasks-template.md — A consumer story fits the existing phases; no new task category.
  ✅ .specify/templates/commands/*.md     — Directory not present in this project; nothing to update.

Runtime guidance:
  ✅ README.md — events table lists `identity.user-registered` (consumer planned); "Customers"
    section describes how customers are created; `POST /orders` documents the 404 for an unknown
    customer; the seed is described as local tooling until the consumer exists.
  ✅ CLAUDE.md — event contracts list the consumed topic, its identity rules and customer
    creation.

Migration note (code that must change, Governance → Amendment procedure):
  ⚠ No consumer for `identity.user-registered` exists yet; customers come only from
    `npm run seed:customers`. A follow-up story MUST add the consumer (own consumer group),
    insert into `customers` keyed by `customerId`, dedupe through `processed_events` and
    dead-letter through `consumed_message_dead_letters`, like the other consumers.
  ⚠ `CustomerEntity` is documented as a "read-only reference row"; the follow-up story makes it
    written by the consumer and MUST update that JSDoc.
  ⚠ docs/events/ has no user-registered.md yet; add it with the consumer, consistent with
    ecommerce-infra/docs/events.md (which lists the Orders consumer as planned).
  ⚠ The follow-up story SHOULD record the customer-creation decision as an ADR (next free
    number in docs/adr/).

Deferred TODOs:
  (none)
-->

<!--
SYNC IMPACT REPORT (previous amendment)
=======================================
Version change:    1.1.0 → 1.2.0
Bump rationale:    MINOR — materially expanded guidance: two new consumed topics (Inventory stock
                   outcomes) and a joined order lifecycle (confirm on payment AND stock, cancel
                   on either failure). No principle removed or renamed.

Modified principles:
  - I. Domain-Driven Design & Layered Architecture — order lifecycle rule added: an order is
    confirmed only when the payment is processed AND the stock is reserved; it is cancelled as
    soon as either the payment fails or the stock is rejected; outcomes may arrive in any order;
    outcomes for an order that is no longer PENDING are ignored and logged. The join is
    implemented in the Domain layer.
  - III. Write Flow Integrity — status transitions driven by the two outcomes follow the same
    save-first-then-publish sequence; recording the first outcome of a pending order is a
    persisted state change but does not change `OrderStatus`.
  - VII. Kafka Events (Producer & Consumers) — consumed topics `inventory.stock-reserved` and
    `inventory.stock-rejected` (published by ecommerce-inventory); their `aggregateId` is the
    reservation id and MUST NOT be used as an order id (order identified by `orderId`); offsets
    committed only after the PostgreSQL save, same consumer rules as the payment consumers.

Added sections:
  - (no new top-level sections)
  - Documentation Standards: Kafka payload documentation in this repo MUST stay consistent with
    `ecommerce-infra/docs/events.md`.

Removed sections:
  - (none)

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates derive from this file at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; no mandatory section added or removed.
  ✅ .specify/templates/tasks-template.md — Consumer/domain work fits existing phases; no new task category.
  ✅ .specify/templates/commands/*.md     — Directory not present in this project; nothing to update.

Runtime guidance:
  ✅ README.md — order lifecycle and events table describe the payment + stock join (stock
    consumer marked planned).
  ✅ CLAUDE.md — event contracts and order lifecycle updated.
  ✅ docs/adr/0006-order-joins-payment-and-stock-outcomes.md — added (0004 is already taken by
    the read-model projection ADR; ADR numbers are never reused). docs/adr/README.md index
    updated; ADR 0003 marked as extended by 0006.

Migration note (code that must change, Governance → Amendment procedure):
  ⚠ Today `decidePaymentReaction` / `ReactToPaymentOutcomeService` confirm an order on
    `payments.payment-processed` alone. A follow-up story MUST add the stock consumer, record
    each outcome on the `Order` aggregate and confirm only once both have succeeded.
  ⚠ `POST /orders/:orderId/confirm` confirms a PENDING order manually, bypassing the join. The
    follow-up story MUST decide whether to remove it or restrict it, and record that decision.
  ⚠ docs/events/ has no stock-reserved.md / stock-rejected.md yet; add them with the consumer,
    consistent with ecommerce-infra/docs/events.md.

Deferred TODOs:
  (none)
-->

<!--
SYNC IMPACT REPORT (earlier amendment)
======================================
Version change:    1.0.0 → 1.1.0
Bump rationale:    MINOR — materially expanded guidance (Kafka consumers, MongoDB read model,
                   ADR numbering, local infrastructure) plus consolidation of the duplicated
                   Principle IX. No principle removed or redefined in a backward-incompatible way.
Note:              Principles VI–IX were added after 1.0.0 without a version bump or report
                   entry; they are recorded here as part of this amendment.

Modified principles:
  - II. CQRS Separation — read model stored in MongoDB, populated by a Kafka projection;
    read-path models never shared with write-path TypeORM entities.
  - VI. Testing Strategy — read-flow component tests use a real MongoDB container.
  - VII. Kafka & Event Publishing → VII. Kafka Events (Producer & Consumers) — "producer only"
    replaced; produced/consumed topics listed; consumer rules (idempotency by eventId, offset
    commit only after DB save, exponential backoff, then dead-letter); payment events identify
    the order by `orderId`, never by `aggregateId` (which is the payment id).
  - IX. "Build Integrity" + IX. "Build & Code Quality Integrity" → merged into a single
    IX. Build & Code Quality Integrity (NON-NEGOTIABLE) with the four-step gate
    (build, lint, format:check, test) and the ESLint/config requirements.

Added sections:
  - (no new top-level sections)
  - Technology Stack: MongoDB via @nestjs/mongoose, testcontainers for MongoDB,
    "Local infrastructure: ecommerce-infra (docker compose)".
  - Documentation Standards: ADRs live in docs/adr/ and are numbered (0001-...).

Removed sections:
  - Duplicate "IX. Build Integrity (NON-NEGOTIABLE)" (content subsumed by the merged IX).

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates derive from this file at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; no mandatory section added or removed.
  ✅ .specify/templates/tasks-template.md — Phase/story structure compatible; consumer/projection work fits existing phases.
  ✅ .specify/templates/commands/*.md     — Directory not present in this project; nothing to update.

Runtime guidance:
  ✅ src/README.md — "producer only" / "separate future service" statements removed.
  ✅ README.md, CLAUDE.md — added at repo root, aligned with this version.
  ✅ docs/adr/ — index, template and ADRs 0001–0003 added.

Deferred TODOs:
  (none)
-->

# ecommerce-orders Constitution

## Core Principles

### I. Domain-Driven Design & Layered Architecture

The codebase MUST follow a strict four-layer model: **Controller → Service → Domain → Repository**.

- **Controllers** handle HTTP/GraphQL I/O only — routing, deserialization, and response shaping. No logic.
- **Services** orchestrate workflows and coordinate domain objects and repositories. They MUST NOT contain business rules.
- **Domain** is the sole home of all business logic. Entities, value objects, aggregates, and domain events live here.
- **Repositories** abstract persistence. They MUST NOT leak ORM internals into domain objects.

`Order` is the aggregate root. `OrderItem` is a value object. Domain events (`OrderPlaced`, `OrderConfirmed`, `OrderCancelled`) are raised by the domain and consumed by infrastructure.
Placing business logic in controllers or services is a constitutional violation and MUST be rejected in code review.

**Order lifecycle.** An order is placed `PENDING` and waits for two independent outcomes: the
payment outcome (from Payments) and the stock outcome (from Inventory).

- An order MUST be confirmed (`PENDING → CONFIRMED`) only when **both** the payment has been
  processed **and** the stock has been reserved.
- An order MUST be cancelled (`PENDING → CANCELLED`) as soon as **either** the payment fails
  **or** the stock is rejected, without waiting for the other outcome.
- The two outcomes MAY arrive in any order. A first successful outcome is recorded on the
  pending order and the order stays `PENDING` until the second one arrives.
- An outcome that arrives for an order that is no longer `PENDING` MUST be ignored (no state
  change, no event published) and logged.
- This join is business logic: it MUST be implemented in the Domain layer (the `Order` aggregate
  or a pure domain policy). Kafka consumers and services MUST NOT decide it.

Rationale: confirming on payment alone would confirm orders whose stock cannot be delivered;
see `docs/adr/0006-order-joins-payment-and-stock-outcomes.md`.

### II. CQRS Separation (NON-NEGOTIABLE)

Write and read paths are architecturally separate and MUST NEVER be mixed.

- **Write path**: REST endpoints → NestJS `@nestjs/cqrs` command bus → Command Handlers → Domain → Repository.
- **Read path**: GraphQL queries → NestJS `@nestjs/cqrs` query bus → Query Handlers → the read model.
- The **read model is stored in MongoDB**. It is populated exclusively by a projection that consumes
  this service's order events from Kafka (see Principle VII). Query handlers MUST NOT read the
  PostgreSQL write store.
- Write-path models (commands, domain entities, TypeORM entities) MUST NOT be shared with the read
  path and vice versa. Read-path models (Mongoose schemas, GraphQL types) are defined separately
  and MUST NOT import, extend or reuse write-path TypeORM entities.
- The read model is eventually consistent with the write side; this is an accepted trade-off
  (see `docs/adr/0001-cqrs-read-model-in-orders-service.md`).
- A controller MUST issue either a command or a query — never both in the same request handler.

Violating this separation (e.g., a REST endpoint that also returns a GraphQL-shaped query result, or a query handler that mutates state) is a constitutional violation.

### III. Write Flow Integrity (NON-NEGOTIABLE)

The write flow MUST follow this exact sequence and MUST NOT deviate:

1. Controller receives and validates request (via DTO).
2. Service delegates to the Domain layer.
3. Domain executes business logic and raises domain events.
4. Repository persists state to **PostgreSQL first**.
5. **Only after** a successful database save: publish the corresponding Kafka event.

Publishing to Kafka before a confirmed database save is a critical violation. If the DB save fails, no Kafka message MUST be emitted. Command handlers are responsible for enforcing this order. `OrderStatus` transitions (`PENDING → CONFIRMED`, `PENDING → CANCELLED`) are only final once persisted.

The same sequence applies when the transition is driven by a payment or stock outcome (see the
order lifecycle in Principle I): the domain decides, the new state is saved to PostgreSQL, and
only then is `OrderConfirmed` or `OrderCancelled` published. Recording the first successful
outcome of a pending order is a persisted state change that leaves `OrderStatus` at `PENDING`
and publishes no event.

### IV. Type Safety & Input Validation

All code MUST be strictly typed — the `any` TypeScript type is **banned** without exception.

- Every external input boundary (REST body, query params, GraphQL arguments) MUST be represented as a DTO class decorated with `class-validator` and `class-transformer`.
- DTOs are validation contracts. Skipping validation on any input boundary is a constitutional violation.
- Domain objects MUST use TypeScript types and interfaces — no implicit `any`, no type assertions that widen to `unknown` or `any`.
- The `OrderStatus` enum MUST be used for all status fields — bare string literals are prohibited.

All errors MUST use NestJS built-in exceptions (NotFoundException, BadRequestException, etc.).
Domain errors MUST be mapped to HTTP status codes at the controller layer, never in the domain.
Unhandled promise rejections MUST be caught — no silent failures.

### V. Test Coverage

All domain logic and command/query handlers MUST have unit tests.

- Every Command Handler, Query Handler, and Domain method MUST have at least one unit test covering the happy path and at least one covering an error/edge case.
- Domain tests MUST NOT depend on NestJS DI, databases, or Kafka — pure unit tests only.
- Handler tests MAY use lightweight mocks for repositories and event buses.
- Tests are not optional: a PR that adds a handler or domain method without corresponding tests MUST NOT be merged.

### VI. Testing Strategy

Three test layers are required:

- **Unit tests** — domain logic and handlers in isolation. No NestJS, no DB, no Kafka.
- **Integration tests** — REST endpoints and GraphQL resolvers. Real test DB via testcontainers. Test happy path, errors, and edge cases.
- **Component tests** — full NestJS app with real dependencies. Only Kafka and other microservices are mocked. Tests the complete write flow (REST → DB → Kafka emitted) and read flow (GraphQL → read DB → response).
  Read-flow component tests MUST use a real MongoDB container (testcontainers), not an in-memory fake.

Tools: Jest, Supertest, @nestjs/testing, testcontainers (PostgreSQL, Kafka, MongoDB).
Minimum coverage: 80% on domain and application layers.
Test names MUST describe the behaviour: "should publish OrderPlaced event after successful DB save".

### VII. Kafka Events (Producer & Consumers)

Kafka is the event bus between services. This service both **produces** and **consumes** events.

**Produced topics** (one domain event per topic, named `orders.<event-name>` in kebab-case):
- `orders.order-placed`
- `orders.order-confirmed`
- `orders.order-cancelled`

**Consumed topics:**
- `payments.payment-processed` — records the payment success; confirms the referenced order once
  the stock is also reserved (Principle I).
- `payments.payment-failed` — cancels the referenced order.
- `inventory.stock-reserved` (published by ecommerce-inventory) — records the stock reservation;
  confirms the referenced order once the payment is also processed (Principle I).
- `inventory.stock-rejected` (published by ecommerce-inventory) — cancels the referenced order.
- `identity.user-registered` (published by ecommerce-identity) — creates the Orders customer
  (see **Customers** below).
- The authoritative contract for every cross-service topic is `ecommerce-infra/docs/events.md`.
- This service's own `orders.*` events — feed the projection that builds the MongoDB read model
  (see Principle II).

**Event publishing rules:**
- Events MUST only be published after a confirmed PostgreSQL save (see Principle III).
- Each domain event maps to exactly one Kafka topic.

**Event payload rules:**
- Every event MUST include: `eventId` (UUID), `occurredAt` (ISO timestamp), `aggregateId` (UUID of
  the producing aggregate), and `version` (integer).
- For `orders.*` events, `aggregateId` is the order id.
- Payment events identify the order by their `orderId` field. Their `aggregateId` is the
  **payment id** and MUST NOT be used as an order id.
- Inventory events identify the order by their `orderId` field, exactly like payment events.
  Their `aggregateId` is the **reservation id** and MUST NOT be used as an order id.
- `identity.user-registered` carries the customer id in its `customerId` field, which MUST be
  used as the Orders customer id. Its `aggregateId` is the **user id** and MUST NOT be used as a
  customer id.
- Payloads MUST be serialized as JSON.
- Breaking changes to a payload schema require a new topic version (e.g. `orders.order-placed.v2`).
- Event classes MUST be documented with JSDoc describing every field.

**Customers:**
- Orders customers are created from `identity.user-registered`: one customer per event, with the
  event's `customerId` as its id. The REST and GraphQL APIs MUST NOT create customers. Seed
  scripts are local-development and test tooling only.
- Customer creation is eventually consistent with Identity. An order placed for a customer that
  Orders has not created yet MUST be rejected exactly as for an unknown customer today
  (`404`, no order saved, no event published); it is not queued or retried.
- Creating a customer that already exists (for example a seeded one) MUST be a no-op, not a
  failure.

**Producer failure handling:**
- If Kafka publish fails after a successful DB save, the error MUST be logged with full context.
- Failed events MUST be stored in a dead-letter table in PostgreSQL for retry.
- The service MUST NOT throw a 500 to the client for Kafka publish failures — the DB save already succeeded.

**Consumer rules (all consumers, including the projection):**
- Consumers MUST be idempotent: events are deduplicated by `eventId`, and processing the same
  event twice MUST produce the same result.
- Offsets MUST be committed only after the resulting database save has succeeded (PostgreSQL for
  the payment, stock and customer consumers, MongoDB for the projection).
- The stock and customer (`identity.user-registered`) consumers follow exactly the same rules as
  the payment consumers: dedupe by `eventId` in the same transaction as the state change, retry
  with backoff, then dead-letter.
- Failed processing MUST be retried with exponential backoff; once retries are exhausted the
  event MUST be dead-lettered and the failure logged with full context.
- State changes driven by consumed events MUST go through the same Domain → Repository path as
  REST commands (Principles I and III). Consumers MUST NOT contain business logic.

### VIII. Branching Strategy

This project follows a **feature-branch workflow** tied to user stories.

**Branch naming convention:**
- Feature branches: `feature/US-XX-short-description`
- Bug fixes: `fix/US-XX-short-description`
- Infrastructure: `chore/short-description`

Examples:
- `feature/US-01-place-order`
- `feature/US-02-cancel-order`
- `feature/US-04-get-orders-query`

**Rules:**
- `main` is always production-ready — never commit directly to main.
- Every user story gets its own branch created from `main`.
- Branch MUST be created before any implementation begins.
- Each branch maps to exactly one user story.
- PRs MUST reference the user story: "Implements US-01: Place an order".
- Branches MUST be deleted after merge.
- Commit messages MUST follow Conventional Commits:
  `feat(US-01): add place order command handler`
  `test(US-01): add unit tests for place order handler`
  `docs(US-01): add JSDoc to order aggregate`

**Automated branch creation (MANDATORY):**
When /speckit.specify is invoked for a user story, Claude Code MUST:
1. Ensure the working tree is clean (no uncommitted changes)
2. Checkout main and pull latest: `git checkout main && git pull`
3. Create and checkout the feature branch: `git checkout -b feature/US-XX-short-description`
4. Only then proceed with generating the spec

The branch MUST exist before any spec file is written.
Claude Code MUST NOT generate spec files while on main.

### IX. Build & Code Quality Integrity (NON-NEGOTIABLE)

The project MUST compile and pass all quality checks at all times.

**After every task implementation, Claude Code MUST run in this order:**

1. `npm run build`        — TypeScript compilation MUST pass
2. `npm run lint`         — ESLint MUST pass with zero errors
3. `npm run format:check` — Prettier formatting MUST be consistent
4. `npm run test`         — all existing tests MUST still pass

**Rules:**
- If any of the above fails, Claude Code MUST fix it before
  moving to the next task.
- A failing build, lint error, or formatting violation
  MUST never be committed to the branch.
- TypeScript compilation errors are blocking issues — not warnings, not deferred items.
- `npm run lint` runs with `--max-warnings 0`, so lint warnings are blocking as well as errors.
- Claude Code MUST NOT mark a task as complete until
  all four checks pass.

**Tooling:**
- Linter: ESLint with @typescript-eslint rules
- Formatter: Prettier
- Build: TypeScript compiler via NestJS build
- Tests: Jest

**ESLint rules (minimum):**
- @typescript-eslint/no-explicit-any — error (enforces Principle IV)
- @typescript-eslint/explicit-function-return-type — error
- @typescript-eslint/no-unused-vars — error
- prettier/prettier — error

**Configuration files required:**
- `.eslintrc.js` — ESLint config
- `.prettierrc` — Prettier config
- `tsconfig.json` — strict mode enabled
  (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`)

## Technology Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js + TypeScript |
| Framework | NestJS |
| CQRS Bus | `@nestjs/cqrs` |
| REST API docs | Swagger / OpenAPI (auto-generated from NestJS decorators) |
| GraphQL | Apollo Server via `@nestjs/graphql` |
| Messaging | Kafka via `kafkajs` |
| Persistence (write side) | TypeORM + PostgreSQL |
| Persistence (read model) | MongoDB via `@nestjs/mongoose` |
| Validation | `class-validator` + `class-transformer` |
| Testing | Jest, Supertest, `@nestjs/testing`, testcontainers (PostgreSQL, Kafka, MongoDB) |
| Containerization | Docker (multi-stage `Dockerfile`) |
| Local infrastructure | ecommerce-infra (docker compose) |

Introducing a new runtime dependency that duplicates a capability already provided by the stack above requires an ADR in `docs/adr/` before the PR can be merged.

## Documentation Standards

All public classes, methods, and interfaces MUST carry JSDoc comments.
GraphQL types and fields MUST include `description` strings visible in the generated schema.
Swagger/OpenAPI annotations MUST be present on all REST endpoints and DTOs so that the spec is auto-generated without manual editing.
Kafka event payloads MUST be documented (field names, types, semantics) in `docs/events/` or inline in the event class JSDoc.
That documentation MUST stay consistent with the platform-wide contract in
`ecommerce-infra/docs/events.md`: a payload change updates both in the same change, and a
discrepancy is a defect.
Each NestJS module MUST include a `README.md` describing its responsibility, exposed endpoints/queries, and domain events it produces or consumes.
Architectural decisions MUST be recorded as ADRs in `docs/adr/` using the standard template (Context / Decision / Consequences).
ADRs are numbered sequentially with a four-digit prefix (`0001-short-title.md`, `0002-...`), are
never renumbered, and are indexed in `docs/adr/README.md`. A superseded ADR is kept and marked as
superseded by the newer one.

## Governance

This constitution supersedes all other project conventions and style guides. When a conflict arises, the constitution takes precedence.

**Amendment procedure**: Any amendment requires (1) a draft PR updating this file, (2) a version bump per the policy below, (3) approval from at least one other maintainer, and (4) a migration note if existing code must change.

**Versioning policy**:
- MAJOR: Removal or redefinition of an existing principle (breaking governance change).
- MINOR: Addition of a new principle or materially expanded guidance.
- PATCH: Clarifications, wording refinements, typo fixes, non-semantic changes.

**Compliance**: Every PR review MUST verify that no constitutional principle is violated. Reviewers are empowered to block merges for violations without exception. New principles take effect immediately upon merge.

**Version**: 1.3.0 | **Ratified**: 2026-07-03 | **Last Amended**: 2026-11-19
