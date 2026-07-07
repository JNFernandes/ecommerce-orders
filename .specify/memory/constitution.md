<!--
SYNC IMPACT REPORT
==================
Version change:    [TEMPLATE] → 1.0.0
Bump rationale:    Initial population — all placeholders replaced; no prior versioned constitution existed.

Modified principles:
  (none — first ratification)

Added sections:
  - Core Principles (I–V)
  - Technology Stack
  - Documentation Standards
  - Governance

Removed sections:
  (none)

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gate references constitution at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; compatible with domain model and CQRS constraints defined here.
  ✅ .specify/templates/tasks-template.md — Phase/story structure is compatible; DDD layer breakdown maps naturally to implementation phases.

Deferred TODOs:
  (none — all fields resolved from user input)
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

### II. CQRS Separation (NON-NEGOTIABLE)

Write and read paths are architecturally separate and MUST NEVER be mixed.

- **Write path**: REST endpoints → NestJS `@nestjs/cqrs` command bus → Command Handlers → Domain → Repository.
- **Read path**: GraphQL queries → NestJS `@nestjs/cqrs` query bus → Query Handlers → read-optimized data sources.
- Write-path models (commands, domain entities) MUST NOT be shared with the read path and vice versa.
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

Tools: Jest, Supertest, @nestjs/testing, testcontainers.
Minimum coverage: 80% on domain and application layers.
Test names MUST describe the behaviour: "should publish OrderPlaced event after successful DB save".

### VII. Kafka & Event Publishing

Kafka is the outbound event bus. This service is a **producer only** for domain events.

**Event publishing rules:**
- Events MUST only be published after a confirmed PostgreSQL save (see Principle III).
- Each domain event maps to exactly one Kafka topic.
- Topics follow the naming convention: `orders.<event-name>` in kebab-case.
  - `orders.order-placed`
  - `orders.order-confirmed`
  - `orders.order-cancelled`

**Event payload rules:**
- Every event MUST include: `eventId` (UUID), `occurredAt` (ISO timestamp), `aggregateId` (order UUID), and `version` (integer).
- Payloads MUST be serialized as JSON.
- Breaking changes to a payload schema require a new topic version (e.g. `orders.order-placed.v2`).
- Event classes MUST be documented with JSDoc describing every field.

**Failure handling:**
- If Kafka publish fails after a successful DB save, the error MUST be logged with full context.
- Failed events MUST be stored in a dead-letter table in PostgreSQL for retry.
- The service MUST NOT throw a 500 to the client for Kafka publish failures — the DB save already succeeded.

**Consumer rules (projection processor only):**
- The projection processor consumes events from Kafka to update the read model.
- It MUST be idempotent — processing the same event twice MUST produce the same result.
- Failed projections MUST be retried with exponential backoff before going to dead-letter.

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

### IX. Build Integrity (NON-NEGOTIABLE)

The project MUST compile successfully at all times.

**Rules:**
- After every task implementation, Claude Code MUST run the build:
  `npm run build`
- If the build fails, Claude Code MUST fix the compilation errors
  before moving to the next task.
- A failing build MUST never be committed to the branch.
- TypeScript compilation errors are treated as blocking issues —
  not warnings, not deferred items.
- Claude Code MUST NOT mark a task as complete if the build fails.

**Build command:** `npm run build`
**Type check command:** `npm run type-check` (if configured)

This ensures the codebase is always in a deployable state
and TypeScript type errors are caught immediately, not accumulated.

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
- Lint warnings are reviewed — lint errors are blocking.
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
| Persistence | TypeORM + PostgreSQL |
| Validation | `class-validator` + `class-transformer` |
| Containerization | Docker + docker-compose |

Introducing a new runtime dependency that duplicates a capability already provided by the stack above requires an ADR in `docs/adr/` before the PR can be merged.

## Documentation Standards

All public classes, methods, and interfaces MUST carry JSDoc comments.
GraphQL types and fields MUST include `description` strings visible in the generated schema.
Swagger/OpenAPI annotations MUST be present on all REST endpoints and DTOs so that the spec is auto-generated without manual editing.
Kafka event payloads MUST be documented (field names, types, semantics) in `docs/events/` or inline in the event class JSDoc.
Each NestJS module MUST include a `README.md` describing its responsibility, exposed endpoints/queries, and domain events it produces or consumes.
Architectural decisions MUST be recorded as ADRs in `docs/adr/` using the standard template (Context / Decision / Consequences).

## Governance

This constitution supersedes all other project conventions and style guides. When a conflict arises, the constitution takes precedence.

**Amendment procedure**: Any amendment requires (1) a draft PR updating this file, (2) a version bump per the policy below, (3) approval from at least one other maintainer, and (4) a migration note if existing code must change.

**Versioning policy**:
- MAJOR: Removal or redefinition of an existing principle (breaking governance change).
- MINOR: Addition of a new principle or materially expanded guidance.
- PATCH: Clarifications, wording refinements, typo fixes, non-semantic changes.

**Compliance**: Every PR review MUST verify that no constitutional principle is violated. Reviewers are empowered to block merges for violations without exception. New principles take effect immediately upon merge.

**Version**: 1.0.0 | **Ratified**: 2026-07-03 | **Last Amended**: 2026-07-03
