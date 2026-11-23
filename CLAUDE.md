# CLAUDE.md

Orders microservice: NestJS + TypeScript, DDD, CQRS. The source of truth for every rule below is
`.specify/memory/constitution.md`. If this file and the constitution disagree, the constitution wins.

## Stack

- NestJS 10, TypeScript (strict, `any` banned), `@nestjs/cqrs`
- Write side: REST + Swagger, TypeORM + PostgreSQL
- Read side: MongoDB read model `order_views` via `@nestjs/mongoose` (US-05), served by a
  code-first Apollo GraphQL API at `/graphql`: `orders` (paged list, US-06) and `order(orderId)`
  (by id, US-07)
- Kafka via `kafkajs`
- Jest, Supertest, `@nestjs/testing`, testcontainers
- Local infra comes from the `ecommerce-infra` repo (`docker compose up -d` there): Kafka
  `localhost:9092`, Postgres `localhost:5432`, MongoDB `localhost:27017`
- Startup never waits for Kafka or MongoDB. The producer connects lazily on first publish
  (memoized in `OrderEventsProducer`); consumers connect in the background through
  `KafkaConnectLoop` (`src/infra/kafka/kafka-connect-loop.ts`). Don't add awaited
  `connect()` calls to module factories or lifecycle hooks.

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
- "Not found" is not an error: `order(orderId)` returns `null` with no `errors` entry. Nullable
  fields that fail also come back `null`, so clients tell failures apart by the `errors` entry.
- GraphQL errors: validation → `BAD_USER_INPUT`, read model down → `SERVICE_UNAVAILABLE`
  (`src/graphql/graphql-user-input.filter.ts`, applied with `@UseFilters` on resolvers).
- A request handler issues a command **or** a query, never both.

## Authentication (US-11)

- Every REST route and GraphQL operation needs an Identity access token (RS256, verified locally
  by `AccessTokenVerifier` in `src/infra/auth/` with `jose` 5.10; not 6.x, it is ESM-only). See
  ADR 0008 and `specs/009-identity-token-auth/`.
- Global guards from `AuthModule`, in order `JwtAuthGuard` → `RolesGuard`, so answers come
  401/503 → 403 → 400 → 404/409. REST token failures are `AccessTokenError`, answered by
  `AuthExceptionFilter` (fixed 401 body with `WWW-Authenticate: Bearer`, or 503).
- Every controller route and resolver needs `@Public()` or `@Roles(...)` (handler or class);
  `RoutePolicyValidator` fails startup otherwise.
- `@CurrentUser()` is the only way handlers get user data. Effective roles: `CUSTOMER` counts only
  with a `customerId`. `POST /orders` takes the customer from the token (body `customerId` → 400).
- Ownership is a domain rule: `Order.isAccessibleBy(OrderRequester)`, enforced by the service;
  another customer's order is the same `404` as a missing one. Never in guards or controllers.
- GraphQL: the token is verified once in the context (`src/graphql/graphql-context.ts`);
  `graphqlAuthPlugin` rejects operations without a caller (`UNAUTHENTICATED` /
  `SERVICE_UNAVAILABLE`, no data, HTTP 200); `RolesGuard` answers `FORBIDDEN`. Use
  `graphqlModule()` (`src/graphql/graphql.config.ts`) to mount GraphQL. Results are not scoped
  to the caller until US-12.
- Never log or echo a token, even truncated; log the `AccessTokenError.category` only.
- Never fetch the JWKS at startup, in a module factory or a lifecycle hook (lazy, single flight,
  60 s cooldown, 300 s cache, last good keys kept when a refresh fails).
- Auth env: `IDENTITY_JWKS_URL`, `JWT_ISSUER` and `JWT_AUDIENCE` (both required, startup fails
  without them), `JWT_CLOCK_TOLERANCE_SECONDS` (5).
- Tests: `withTestIdentity()` (`tests/support/auth-testing.ts`) starts a fake Identity
  (`tests/support/test-identity.ts`) and gives role headers; call it before compiling the module.

## Event contracts

- Produced: `orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled`.
- Consumed: `payments.payment-processed` / `payments.payment-failed` by
  `src/infra/kafka/payment-events.consumer.ts` (group `KAFKA_GROUP_ID`, US-04);
  `inventory.stock-reserved` / `inventory.stock-rejected` (published by ecommerce-inventory) by
  `src/infra/kafka/inventory-events.consumer.ts` (group `KAFKA_INVENTORY_GROUP_ID`, US-09); own
  `orders.*` events by `src/infra/kafka/order-projection.consumer.ts` (group
  `KAFKA_PROJECTION_GROUP_ID`, US-05); `identity.user-registered` (published by
  ecommerce-identity) creates the customer via
  `src/infra/kafka/identity-events.consumer.ts` (group `KAFKA_IDENTITY_GROUP_ID`, US-10).
- `OrderCancelled` has an optional `reason`: `payment failed: <reason>` or `stock rejected:
  <reason>` for outcome-driven cancels; omitted for REST cancels.
- Every payload: `eventId` (UUID), `occurredAt` (ISO), `aggregateId` (UUID), `version` (int), JSON.
- Payment and Inventory events identify the order by **`orderId`**. Their `aggregateId` is the
  payment id / reservation id: never use it as an order id.
- Customers: created only from `identity.user-registered`, keyed by its **`customerId`** field
  (its `aggregateId` is the user id: never use it as a customer id). The APIs never create
  customers; `npm run seed:customers` is local/test tooling. Eventual consistency: an order for
  a customer Orders hasn't created yet gets the usual `404` (not queued). Creating an existing
  customer is a no-op. Same consumer rules as payment/stock (dedupe, commit after save, backoff,
  dead-letter).
- Order lifecycle (constitution 1.2.0, ADR 0006): confirm only when payment processed **and**
  stock reserved; cancel as soon as payment fails **or** stock is rejected; outcomes arrive in any
  order; an outcome for a non-`PENDING` order is ignored and logged (warning for a processed
  payment on a cancelled order: it needs a refund); the first outcome of each side wins. The
  join lives in the `Order` aggregate (`record*()` methods, returning `{ record, attention }`),
  never in consumers or services, which go through `ApplyPaymentOutcomeCommand` /
  `ApplyStockOutcomeCommand` → `OutcomeWriteFlow`. The outcome write is guarded on the outcomes
  the order was loaded with (`OrderRepository.applyOutcome`), so concurrent outcomes retry
  instead of both missing the confirmation. `POST /orders/:orderId/confirm` stays an operator
  override.
- `docs/events/` must stay consistent with `ecommerce-infra/docs/events.md`.
- Consumers: idempotent (dedupe by `eventId` in `processed_events`, written in the same
  transaction as the state change), commit offsets only after the DB save, retry with exponential
  backoff (`retry-with-backoff.ts`), then dead-letter to `consumed_message_dead_letters`. A
  consumer is an inbound adapter: parse a DTO, dispatch a command, commit. No business logic.
- Every consumer goes through `consumeWithDeadLetter` (`src/infra/kafka/`). A store outage
  (e.g. `ReadModelUnavailableError`) is `isFatal`: rethrown, not dead-lettered, not committed.
- Kafka latency env: `KAFKA_CONNECTION_TIMEOUT_MS` (1000) and `KAFKA_PRODUCER_RETRIES` (1) bound a
  failed publish to about 3 s. They apply to the producer's own kafkajs client only; the
  consumers' client keeps kafkajs's default retries.
- Consumer env: `KAFKA_GROUP_ID`, `KAFKA_INVENTORY_GROUP_ID`, `KAFKA_PROJECTION_GROUP_ID`, `KAFKA_IDENTITY_GROUP_ID`, `MONGO_URI`, `KAFKA_CONSUMER_ENABLED`, `PAYMENT_CONSUMER_MAX_ATTEMPTS`,
  `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, `PAYMENT_CONSUMER_BACKOFF_MAX_MS`.

## Dead-letter retry (US-08)

- Both dead-letter tables have `status` `PENDING_RETRY` / `RESOLVED` / `EXHAUSTED`, `retryCount`,
  `nextRetryAt`, `lastAttemptAt`, `lastError`, `resolvedAt`. Malformed inbound rows are inserted
  `EXHAUSTED`. See `docs/dead-letter-retry.md` and ADR 0005.
- `DeadLetterRetryWorker` (`src/infra/dead-letter/`) retries them: one row per transaction via
  `processNextDue` (`FOR UPDATE SKIP LOCKED`), decision by the pure `decideRetry`.
- Outbound rows are republished only through `OrderEventsProducer.republish` (same `eventId`, key
  `aggregateId`). Inbound rows go only through the owning consumer's `process()`. Never
  duplicate their logic in the worker.
- A retry never commits offsets and never creates a new dead letter.
- Env: `DEAD_LETTER_RETRY_ENABLED`, `DEAD_LETTER_RETRY_INTERVAL_MS`, `DEAD_LETTER_BATCH_SIZE`,
  `DEAD_LETTER_BASE_DELAY_MS`, `DEAD_LETTER_MAX_DELAY_MS`, `DEAD_LETTER_MAX_RETRIES`.
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
