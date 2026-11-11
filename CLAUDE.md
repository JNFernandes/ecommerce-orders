# CLAUDE.md

Orders microservice: NestJS + TypeScript, DDD, CQRS. The source of truth for every rule below is
`.specify/memory/constitution.md`. If this file and the constitution disagree, the constitution wins.

## Stack

- NestJS 10, TypeScript (strict, `any` banned), `@nestjs/cqrs`
- Write side: REST + Swagger, TypeORM + PostgreSQL
- Read side (planned): GraphQL (Apollo) + MongoDB via `@nestjs/mongoose`
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

- Write: REST → command bus → handler → domain → **PostgreSQL save first → then Kafka publish**.
  Never publish before the save succeeds. If the publish fails, log it, write to the dead-letter
  table and still return success.
- Read: GraphQL → query bus → query handler → MongoDB read model, built by a projection that
  consumes `orders.*` events. Query handlers never read Postgres. Read models never reuse
  TypeORM entities.
- A request handler issues a command **or** a query, never both.

## Event contracts

- Produced: `orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled`.
- Consumed (planned): `payments.payment-processed` (confirm), `payments.payment-failed` (cancel),
  and own `orders.*` events (read-model projection).
- Every payload: `eventId` (UUID), `occurredAt` (ISO), `aggregateId` (UUID), `version` (int), JSON.
- Payment events identify the order by **`orderId`**. Their `aggregateId` is the payment id: never
  use it as an order id.
- Consumers: idempotent (dedupe by `eventId`), commit offsets only after the DB save, retry with
  exponential backoff, then dead-letter.
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

- JSDoc on public classes and methods. Swagger on REST endpoints and DTOs. `description` on GraphQL
  types and fields.
- Architectural decisions go in `docs/adr/NNNN-title.md` (Context / Decision / Consequences),
  indexed in `docs/adr/README.md`.
