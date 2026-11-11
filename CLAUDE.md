# CLAUDE.md

Orders microservice: NestJS + TypeScript, DDD, CQRS. The source of truth for every rule below is
`.specify/memory/constitution.md`. If this file and the constitution disagree, the constitution wins.

## Stack

- NestJS 10, TypeScript (strict, `any` banned), `@nestjs/cqrs`
- Write side: REST + Swagger, TypeORM + PostgreSQL
- Read side: MongoDB read model `order_views` via `@nestjs/mongoose` (US-05), served by a
  code-first Apollo GraphQL API at `/graphql` (`orders` query, US-06; order by id planned, US-07)
- Kafka via `kafkajs`
- Jest, Supertest, `@nestjs/testing`, testcontainers
- Local infra comes from the `ecommerce-infra` repo (`docker compose up -d` there): Kafka
  `localhost:9092`, Postgres `localhost:5432`, MongoDB `localhost:27017`

## Commands

```bash
npm run build
npm run lint
npm run format:check
npm run test            # also: test:unit, test:integration, test:component (needs Docker)
npm run migration:run
npm run schema:generate   # after any GraphQL change; a test fails while docs/schema.gql is stale
```

## Quality gate (after every task, before every commit)

Run `npm run build`, `npm run lint`, `npm run format:check` and `npm run test`, in that order. All
four must pass. Fix any failure before moving on. Never commit a failing build, a lint error or
warning (`--max-warnings 0`), or a formatting violation.

## Layering

**Controller → Service → Domain → Repository.**

- Controllers: HTTP/GraphQL I/O and DTO validation only. Map domain errors to HTTP exceptions.
- Services / command handlers: orchestrate only (domain → repository → Kafka).
- Domain (`src/domain/`): **all** business logic. No I/O, no NestJS.
- Repositories: persistence only. Map domain objects to and from TypeORM entities.
- **Business logic never goes in controllers or services.** This includes Kafka consumers.

## CQRS and write flow

- Read side lives in `src/read-model/` and MUST NOT import from `src/domain`,
  `src/infra/database/entities`, `src/services` or `src/repositories`. Projection rules are the
  pure `projectOrderEvent`; views are deterministic (event times, sorted ids) — see
  `docs/read-model.md` and ADR 0004.

- Write: REST → command bus → handler → domain → **PostgreSQL save first → then Kafka publish**.
  Never publish before the save succeeds. If the publish fails, log it, write to the dead-letter
  table and still return success.
- Read: GraphQL resolver (`src/controllers/*.resolver.ts`) → `QueryBus` → `@QueryHandler`
  (`src/services/`, query objects in `src/queries/`) → `OrderViewRepository` (MongoDB). Resolvers
  dispatch queries only (never the `CommandBus`); query handlers never read Postgres; GraphQL
  types live in `src/dto/graphql/`, are built from `OrderView` (never TypeORM entities or the
  `Order` aggregate) and never expose read-model bookkeeping (`appliedEventIds`, `revision`, …).
- GraphQL errors: validation → `BAD_USER_INPUT`, read model down → `SERVICE_UNAVAILABLE`
  (`src/graphql/graphql-user-input.filter.ts`, applied with `@UseFilters` on resolvers).
- A request handler issues a command **or** a query, never both.

## Event contracts

- Produced: `orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled`.
- Consumed: `payments.payment-processed` (confirm) and `payments.payment-failed` (cancel, store
  `reason`) by `src/infra/kafka/payment-events.consumer.ts` (US-04); own `orders.*` events by
  `src/infra/kafka/order-projection.consumer.ts` (group `KAFKA_PROJECTION_GROUP_ID`, US-05).
- `OrderCancelled` has an optional `reason` (payment failures only; omitted for REST cancels).
- Every payload: `eventId` (UUID), `occurredAt` (ISO), `aggregateId` (UUID), `version` (int), JSON.
- Payment events identify the order by **`orderId`**. Their `aggregateId` is the payment id: never
  use it as an order id.
- Consumers: idempotent (dedupe by `eventId` in `processed_events`, written in the same
  transaction as the state change), commit offsets only after the DB save, retry with exponential
  backoff (`retry-with-backoff.ts`), then dead-letter to `consumed_message_dead_letters`. A
  consumer is an inbound adapter: parse a DTO, dispatch a command, commit. No business logic.
- Every consumer goes through `consumeWithDeadLetter` (`src/infra/kafka/`). A store outage
  (e.g. `ReadModelUnavailableError`) is `isFatal`: rethrown, not dead-lettered, not committed.
- Consumer env: `KAFKA_GROUP_ID`, `KAFKA_PROJECTION_GROUP_ID`, `MONGO_URI`, `KAFKA_CONSUMER_ENABLED`, `PAYMENT_CONSUMER_MAX_ATTEMPTS`,
  `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, `PAYMENT_CONSUMER_BACKOFF_MAX_MS`.
- Breaking payload change → new topic version (`orders.order-placed.v2`). Document payloads in
  `docs/events/`.

## Branching and commits

- Never commit to `main`. Branch from an up-to-date `main` with a clean working tree:
  `feature/US-XX-short-description`, `fix/US-XX-short-description`, `chore/short-description`.
- Create the branch before writing any spec or code.
- Conventional Commits, scoped to the story where there is one: `feat(US-01): ...`,
  `test(US-01): ...`, `docs: ...`, `chore: ...`.
- PRs reference the story ("Implements US-01: Place an order").

## Documentation

- JSDoc on public classes and methods. Swagger on REST endpoints and DTOs. `description` on every
  GraphQL type, field, argument and enum value (enforced by `tests/unit/graphql/schema.spec.ts`).
- Architectural decisions go in `docs/adr/NNNN-title.md` (Context / Decision / Consequences),
  indexed in `docs/adr/README.md`.
