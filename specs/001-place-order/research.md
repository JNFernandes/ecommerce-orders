# Phase 0 Research: Place an Order

The technology stack itself is not an open question — it is fixed by the project constitution (NestJS, `@nestjs/cqrs`, TypeORM + PostgreSQL, `kafkajs`, `class-validator`). The research below resolves the design decisions the spec's clarifications (customer-existence check, item consolidation) left open, plus the standard patterns needed to implement the write flow correctly.

## Decision 1: How to verify customer existence

**Decision**: Add a `customers` reference table in the same PostgreSQL database, queried through a `CustomerRepository.existsById(customerId): Promise<boolean>` port called from `PlaceOrderService` before `Order.place()` and before any DB save. How that table is populated (seed data now; a Kafka consumer or a call from a future Customers service later) is an explicit dependency, not built as part of this feature.

**Rationale**:
- Keeps the write path free of a synchronous network call to another service, preserving the write-flow integrity and resilience goals in the spec (a temporary Customers-service outage should not be a new failure mode for order placement).
- Reuses the PostgreSQL dependency already mandated by the stack — no new runtime dependency, so it does not trigger the constitution's "new dependency requires an ADR" rule.
- Abstracting it behind a repository port (Principle I) means the population mechanism can change later without touching the domain or application layers.

**Alternatives considered**:
- *Synchronous REST/gRPC call to an external Customers service*: rejected for this increment — no such service or contract exists yet in this repository, and it would introduce network coupling and a new failure mode directly into the order-placement write path.
- *New Kafka consumer subscribing to customer-registration events*: rejected for this increment as scope expansion beyond what US-01 requires; worth revisiting via an ADR once a Customers-producing service actually exists.

## Decision 2: Read model storage shape (revised)

**Decision (revised)**: This service does not own a read model at all. No `orders_read` table, no `OrderProjection` consumer, no Kafka consumer of any kind lives in this repo — it is a Kafka producer only for `OrderPlaced`. A denormalized, query-optimized view of orders is deferred to a separate future service (its own repo/deployable, own database, own Kafka consumer group) that will consume `orders.order-placed` when a query/GraphQL feature actually needs it.

**Original decision (superseded)**: An earlier iteration had a single PostgreSQL instance holding both the write tables and a denormalized `orders_read` table, updated in-repo by an `OrderProjection` consumer. That was reversed because it blurred the "producer only" boundary from Constitution Principle VII and added a consumer with no real reader (no query/GraphQL endpoint exists yet to read it) — pure speculative scaffolding.

**Rationale for the revision**: Physically separating the read side into its own service is the more literal reading of CQRS (Principle II) — write and read models don't just get separate *tables*, they get separate *services*, each independently deployable and scalable. It also matches the existing sibling infrastructure in this workspace (`ecommerce-infra`'s per-service Postgres containers), which already assumes one database per service, not shared tables within one service standing in for two concerns.

**Alternatives considered**: Keeping the projection in this repo (original decision) — rejected on revision as unnecessary complexity until a real query feature exists to justify it; a separate physical read database within the same repo — rejected as a halfway measure that still couples the future read service's release cycle to this one's.

## Decision 3: Dead-letter handling for failed Kafka publishes

**Decision**: A `order_dead_letters` table stores the event payload, target topic, error message, and a retry count whenever `OrderEventsProducer.publish()` fails after a successful DB save. Building the automated retry/redelivery job itself is out of scope for this feature — only reliably capturing the failure is in scope (matches spec FR-013 and `docs/us-01-place-order.md` AC-03/UT-10).

**Rationale**: The spec's guarantee is that a failure to notify never costs the customer their order and is *tracked* for retry — it does not require the retry mechanism to ship in this increment. Keeping the retry job as a separate, later concern avoids scope creep here while still satisfying the durability guarantee.

**Alternatives considered**: Building a scheduled retry job now — deferred; not required by any acceptance criterion in this user story, and would expand scope beyond "place an order."

## Decision 4: Test infrastructure for integration/component tests

**Decision**: Use Testcontainers to spin up real PostgreSQL and Kafka instances for integration and component tests, per the constitution's Testing Strategy (Principle VI), which explicitly prohibits mocking the database in these layers.

**Rationale**: Matches the constitution's mandated tooling (`Testcontainers`) and testing philosophy — domain/unit tests stay pure and mock-free of infrastructure, while integration/component tests exercise the real write flow (DB save → Kafka publish → projection).

**Alternatives considered**: In-memory/mocked DB and Kafka for integration tests — rejected, explicitly against Principle VI.

## Summary

No `NEEDS CLARIFICATION` markers remain. All four decisions above are documented defaults consistent with the constitution and the clarified spec; none introduce a new runtime dependency or constitutional violation.
