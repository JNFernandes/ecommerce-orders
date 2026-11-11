# Implementation Plan: List Orders over GraphQL (US-06)

**Branch**: `feature/US-06-list-orders-graphql` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-list-orders-graphql/spec.md`, plus the user's
planning directions:
- the resolver in `src/controllers/`;
- `@nestjs/cqrs` `QueryBus` with a `ListOrdersQuery` and its handler in the service layer;
- a read-side method on `OrderViewRepository`;
- indexes declared on the Mongoose schema;
- code-first GraphQL with `autoSchemaFile` in memory, plus a generated `schema.gql` committed under
  `docs/`.

## Summary

Add a code-first Apollo GraphQL endpoint at `/graphql` with one query,
`orders(status, customerId, limit, offset): OrdersPage!`.

- **Flow**: `OrdersResolver` (`src/controllers/`) validates `ListOrdersArgs` through the global
  `ValidationPipe`, dispatches `ListOrdersQuery` on the `QueryBus`, and maps the returned read views
  to GraphQL types. `ListOrdersService` (`@QueryHandler`, `src/services/`) calls the new
  `OrderViewRepository.list()`, which runs a sorted, paged `find` and a `countDocuments` on
  `order_views`, and computes `hasNextPage`.
- **Indexes**: declared on `OrderViewSchema`, created explicitly once the lazy connection is up.
- **Errors**: a resolver-scoped filter turns validation failures into `BAD_USER_INPUT` and
  read-model outages into `SERVICE_UNAVAILABLE`.
- **Dev tooling**: introspection and the Apollo Sandbox are on unless `NODE_ENV=production`.
- **Schema file**: the schema lives in memory at runtime. `npm run schema:generate` writes
  `docs/schema.gql`, and a unit test fails if that file drifts or if any description is missing.

Rationale is in [research.md](research.md) R1–R10.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs` (`QueryBus`), `@nestjs/graphql` 12.2.2 +
`@nestjs/apollo` 12.2.2 + `@apollo/server` 4.13 + `graphql` 16 (all already installed),
`@nestjs/mongoose`/`mongoose` 8 (US-05), `class-validator`. No new dependencies.

**Storage**: MongoDB `order_views` (read model). Three new indexes; no schema or field change.
PostgreSQL is not touched by this feature.

**Testing**: Jest, Supertest (real GraphQL HTTP requests), `@nestjs/testing`, testcontainers
(MongoDB; plus PostgreSQL and Kafka in the component test).

**Target Platform**: Linux container / local Node against `ecommerce-infra`.

**Project Type**: Web service (NestJS: REST write path + GraphQL read path).

**Performance Goals**: A page of up to 100 orders in under 1s with 10k views (SC-005), guaranteed
by index-backed `find` and `count`, which are verified with `explain()`.

**Constraints**:
- Read path only (no commands, no PostgreSQL, no write-model types).
- Every type and field has a description.
- No runtime file writes (in-memory schema).
- No introspection or sandbox in production.

**Scale/Scope**: 1 query, 4 GraphQL types/enums, 1 query handler, 1 repository method, 3 indexes,
1 error filter, the GraphQL module config, a schema printer and its script.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Gate | Status |
|---|---|---|
| I. Layering | Resolver (controller: I/O, response shaping) → `ListOrdersService` (service: orchestration, `hasNextPage`) → `OrderViewRepository` (persistence). No business rules in the resolver. Listing has no domain rule beyond paging arithmetic. | ✅ |
| II. CQRS separation | GraphQL → `QueryBus` → `@QueryHandler` → read model in MongoDB. The resolver issues one query and never a command. Nothing in the read path imports `src/domain`, TypeORM entities or write repositories. GraphQL types are separate classes built from `OrderView`, and the enum comes from the read-side `OrderViewStatus`. | ✅ |
| III. Write flow | Unchanged and untouched. | ✅ (n/a) |
| IV. Type safety & validation | `ListOrdersArgs` is a `class-validator` DTO validated by Nest's built-in `ValidationPipe`. No `any`. Built-in exceptions (`BadRequestException`) are mapped to GraphQL error codes at the controller boundary (a resolver-scoped filter), the GraphQL counterpart of mapping to HTTP codes in controllers. | ✅ |
| V. Test coverage | The handler, resolver and filter have unit tests with happy and edge cases. Coverage thresholds are extended to the new code. | ✅ |
| VI. Testing strategy | Unit, plus integration (real GraphQL queries, MongoDB container), plus component (full stack). | ✅ |
| VII. Kafka | Not affected. The data comes from the US-05 projection. | ✅ (n/a) |
| VIII. Branching | `feature/US-06-list-orders-graphql`, created from an up-to-date `main` before the spec. Commits scoped `US-06`. | ✅ |
| IX. Build & quality | The four-step gate after every task. | ✅ (process) |
| Docs | Every GraphQL type, field, argument and enum value has a `description`, enforced by test. `docs/schema.gql` committed with a drift test. README example queries. `CLAUDE.md`, `src/README.md` and `docs/read-model.md` updated (GraphQL no longer "planned"). No new ADR: the decision is covered by ADR 0001. | ✅ |

**Post-design re-check (after Phase 1)**: still passes. The only cross-cutting change is
`configureApp(app)` (moving the existing global pipe setup out of `main.ts` so tests use the same
configuration), which changes no behaviour. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-list-orders-graphql/
├── spec.md
├── plan.md                         # this file
├── research.md                     # R1–R10
├── data-model.md                   # indexes, repository/query contracts, GraphQL types, errors
├── quickstart.md
├── contracts/graphql-orders-query.md
├── checklists/requirements.md
└── tasks.md                        # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

New files are marked `+`, changed files `~`.

```text
src/
├── main.ts                                   ~ uses configureApp(app)
├── app.setup.ts                              + configureApp: global ValidationPipe (shared with tests)
├── app.module.ts                             ~ GraphQLModule.forRootAsync(...), OrdersResolver, ListOrdersService
├── config/configuration.ts                   ~ graphql.devTools (NODE_ENV !== 'production')
├── controllers/
│   └── orders.resolver.ts                    + @Resolver(OrderType): orders(args) → QueryBus → map to OrdersPageType
├── dto/graphql/
│   ├── order-status.enum.ts                  + registerEnumType(OrderViewStatus, { name: 'OrderStatus', … })
│   ├── order-item.type.ts                    + @ObjectType OrderItem
│   ├── order.type.ts                         + @ObjectType Order (+ static fromView)
│   ├── orders-page.type.ts                   + @ObjectType OrdersPage
│   └── list-orders.args.ts                   + @ArgsType with class-validator rules
├── queries/
│   └── list-orders.query.ts                  + ListOrdersQuery(filter, page)
├── services/
│   └── list-orders.service.ts                + @QueryHandler(ListOrdersQuery) → ListOrdersResult
├── graphql/
│   ├── graphql.config.ts                     + Apollo options factory (sandbox / introspection by env)
│   ├── graphql-user-input.filter.ts          + BadRequest → BAD_USER_INPUT; ReadModelUnavailable → SERVICE_UNAVAILABLE
│   └── print-schema.ts                       + printOrdersSchema() for the script and the drift test
└── read-model/
    ├── order-view.schema.ts                  ~ three .index(...) declarations
    ├── order-view.repository.ts              ~ list(filter, page), ensureIndexes()
    ├── read-model.module.ts                  ~ autoIndex: false
    └── read-model-connection.ts              ~ ensureIndexes() on every successful connect

scripts/generate-graphql-schema.ts            + writes docs/schema.gql
docs/schema.gql                               + generated SDL (committed)

tests/
├── unit/services/list-orders.service.spec.ts           +
├── unit/controllers/orders.resolver.spec.ts            +
├── unit/dto/list-orders.args.spec.ts                   +
├── unit/graphql/{graphql-user-input.filter,schema}.spec.ts +
├── unit/read-model/read-model-connection.spec.ts       ~ ensureIndexes on connect
├── integration/list-orders.graphql.integration.spec.ts +
└── component/list-orders.component.spec.ts             +

package.json (script schema:generate), jest.config.js (coverage), README.md, CLAUDE.md,
src/README.md, docs/read-model.md   ~
```

**Structure Decision**: Keep the layer-first layout, as the user directed. The resolver goes in
`controllers/`, the GraphQL shapes in `dto/graphql/`, the query in `queries/` (mirroring
`commands/`), the handler in `services/` and the persistence method in `read-model/`. GraphQL
plumbing (config, error filter, schema printer) gets a small `src/graphql/` infrastructure folder.

## Follow-ups (out of scope, recorded)

- Cursor-based paging if consumers need stable pages while orders are being placed.
- Authentication and authorisation for the GraphQL endpoint, and per-customer scoping.
- Query cost or depth limiting once the schema grows (US-07 onwards).

## Complexity Tracking

None. No constitution violations to justify.
