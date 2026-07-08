# Implementation Plan: Place an Order

**Branch**: `feature/US-01-place-order` | **Date**: 2026-07-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-place-order/spec.md` (see also `docs/us-01-place-order.md` for the original acceptance-criteria brief)

## Summary

Implement `POST /orders`: a customer submits one or more items; the system verifies the customer exists, validates and consolidates items, computes the total, durably saves a `Pending` order to PostgreSQL, and — only after that save succeeds — publishes an `OrderPlaced` event to Kafka (`orders.order-placed`) that a projection consumer uses to update a read model. Kafka publish failures are logged and stored in a dead-letter table without failing the client response. Built as a NestJS module following the project's mandatory Controller → Service(Handler) → Domain → Repository layering and CQRS command-bus write path.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS

**Primary Dependencies**: NestJS (`@nestjs/core`, `@nestjs/cqrs`), `@nestjs/swagger`, `class-validator` + `class-transformer`, TypeORM, `kafkajs`, `@nestjs/graphql` + Apollo Server (scaffolded per constitution's read-path convention, not exercised by this feature)

**Storage**: PostgreSQL — single instance for this service, holding both the write tables (`orders`, `order_items`) and a denormalized read table (`orders_read`) populated by the projection; plus a `customers` reference table and an `order_dead_letters` table (see data-model.md)

**Testing**: Jest (unit), Supertest + `@nestjs/testing` (integration), Testcontainers for a real PostgreSQL + Kafka in integration/component tests

**Target Platform**: Linux container (Docker / docker-compose), Node.js server process

**Project Type**: Web service (single NestJS backend microservice)

**Performance Goals**: Order placement confirmed to the customer in under 2s under normal load (SC-001); no specific throughput target given for this increment — default to the stack's standard single-instance capacity, revisit if load testing surfaces a bottleneck

**Constraints**: Write flow MUST persist to PostgreSQL before any Kafka publish (Principle III); Kafka publish failure MUST NOT produce a client-visible 500 (AC-03); no `any` types anywhere (Principle IV); domain layer MUST have zero I/O (no DB/Kafka/NestJS DI in `Order`/`OrderItem` tests)

**Scale/Scope**: Single bounded context (Orders), one aggregate (`Order`), one write command (`PlaceOrder`) and its projection consumer; no read (GraphQL query) endpoint is built in this increment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see bottom of this section.*

| Principle | Check | Status |
|---|---|---|
| I. DDD & Layered Architecture | `Order` aggregate + `OrderItem` value object hold all business rules (item consolidation, validation, total calc); `OrdersController` and `PlaceOrderService` contain no business logic; `OrderRepository`/`CustomerRepository` abstract persistence | PASS |
| II. CQRS Separation | This feature only uses the write path (REST → command bus → handler). No GraphQL query is added; the read-model projection is a write-side consequence (event projection), not a query handler | PASS |
| III. Write Flow Integrity | `PlaceOrderService` sequence is fixed: validate → check customer exists → `Order.place()` → `OrderRepository.save()` (PostgreSQL) → only then `OrderEventsProducer.publish()` (Kafka) | PASS |
| IV. Type Safety & Validation | `PlaceOrderDto` validated via `class-validator`; `any` banned; `OrderStatus` enum used for status field | PASS |
| V. Test Coverage | Unit tests planned for `Order.place()` (incl. consolidation) and `PlaceOrderService` (incl. customer-not-found and DB/Kafka failure paths) | PASS |
| VI. Testing Strategy | Unit (pure domain/handlers), integration (REST + real test DB via Testcontainers), component (full write flow incl. Kafka) all scoped in quickstart.md | PASS |
| VII. Kafka & Event Publishing | `OrderPlaced` published to `orders.order-placed` only after DB save; payload matches AC-04; failures go to `order_dead_letters` table | PASS |
| VIII. Branching Strategy | Already on `feature/US-01-place-order`, created from `main` before implementation (done in `/speckit-specify`) | PASS |
| IX. Build & Code Quality Integrity | Plan assumes `npm run build`/`lint`/`format:check`/`test` are run after every implementation task (enforced during `/speckit-implement`, not this planning phase) | PASS (deferred to implementation) |

No violations — **Complexity Tracking is not needed.**

One new architectural surface introduced by this plan that is *not* pre-existing project convention: a `customers` reference table + `CustomerRepository.existsById()` port to support the customer-existence check added to the spec (see research.md Decision 1). This does not violate any principle (it reuses the existing PostgreSQL dependency and follows the same repository-abstraction pattern already mandated), so it is called out here for visibility rather than logged as a Complexity Tracking violation.

*Post-design re-check (after Phase 1): unchanged — data-model.md and contracts/ introduce no new dependencies or layering violations. All rows above still PASS.*

## Project Structure

### Documentation (this feature)

```text
specs/001-place-order/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── rest-place-order.md
│   └── event-order-placed.md
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

This is a greenfield NestJS service (no existing `src/` yet). Single-project layout, organized by bounded context and DDD layer per the constitution:

```text
src/
├── orders/
│   ├── presentation/
│   │   └── rest/
│   │       ├── orders.controller.ts        # POST /orders
│   │       └── dto/
│   │           └── place-order.dto.ts      # class-validator DTO
│   ├── application/
│   │   └── commands/
│   │       └── place-order/
│   │           ├── place-order.command.ts
│   │           └── place-order.service.ts  # orchestrates validate→check→domain→save→publish
│   ├── domain/
│   │   ├── order.aggregate.ts              # Order.place()
│   │   ├── order-item.value-object.ts
│   │   ├── order-status.enum.ts
│   │   └── events/
│   │       └── order-placed.event.ts
│   └── infrastructure/
│       ├── persistence/
│       │   ├── order.entity.ts             # TypeORM entity
│       │   ├── order-item.entity.ts
│       │   ├── order.repository.ts
│       │   └── order-dead-letter.entity.ts
│       ├── kafka/
│       │   └── order-events.producer.ts
│       └── projections/
│           ├── orders-read.entity.ts
│           └── order.projection.ts         # Kafka consumer → orders_read
├── customers/
│   └── infrastructure/
│       └── persistence/
│           ├── customer.entity.ts          # minimal reference entity
│           └── customer.repository.ts      # existsById()
├── app.module.ts
└── main.ts

tests/
├── unit/
│   └── orders/ (domain + handler tests)
├── integration/
│   └── orders/ (REST + DTO validation tests, Testcontainers DB)
└── component/
    └── orders/ (full write flow + projection, Testcontainers DB + Kafka)
```

**Structure Decision**: Single NestJS project (Option 1), with an `orders` module (all four DDD layers) and a minimal `customers` module (infrastructure-only, read-only reference data). No `frontend/` or `api/`+`mobile` split applies — this is a single backend microservice.

## Complexity Tracking

*No entries — no constitutional violations require justification.*
