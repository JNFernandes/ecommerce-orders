# Implementation Plan: Get Order by Id over GraphQL (US-07)

**Branch**: `feature/US-07-get-order-by-id` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-get-order-by-id/spec.md`, plus the user's
planning directions:
- reuse the GraphQL module, the `Order` type, the QueryBus pattern and `OrderViewRepository` from
  US-06;
- add a `GetOrderQuery` and handler, a repository lookup, one resolver method and a small args
  class;
- no new dependencies and no migration.

## Summary

Add `order(orderId: ID!): Order` (nullable) to the existing `OrdersResolver`. It validates
`GetOrderArgs` (`@IsUUID`) through the global `ValidationPipe`, dispatches `GetOrderQuery` on the
`QueryBus`, and maps the result with `OrderType.fromView`, or returns `null`.

`GetOrderService` (`@QueryHandler`) lower-cases the id and calls the **existing**
`OrderViewRepository.findById` (a primary-key lookup on `order_views`). The existing
`GraphQLUserInputFilter` already produces `BAD_USER_INPUT` and `SERVICE_UNAVAILABLE`. The schema
gains one described query, and `docs/schema.gql` is regenerated. Details are in
[research.md](research.md) R1–R6.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node.js 20

**Primary Dependencies**: Unchanged: NestJS 10, `@nestjs/cqrs`, `@nestjs/graphql`/`@nestjs/apollo`,
Mongoose 8, `class-validator`. **No new dependencies.**

**Storage**: MongoDB `order_views`, read only, by `_id`. **No migration, no new index** (primary
key).

**Testing**: Jest, Supertest (real GraphQL), testcontainers. The US-06 harnesses are extended,
not duplicated.

**Target Platform / Project Type**: unchanged (NestJS web service).

**Performance Goals**: A lookup in under 200 ms at 10k views (SC-005), from the primary-key lookup.

**Constraints**: Read path only. `null` means not found, with no error. Every new element has a
description. The `Order` type, repository, filter and module are reused.

**Scale/Scope**: About 4 new small files (args, query, handler, handler test), 1 resolver method,
and extensions to existing tests and docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Layering | Resolver (I/O, mapping) → `GetOrderService` (orchestration plus id normalisation) → `OrderViewRepository`. No business rules in the resolver. | ✅ |
| II. CQRS | GraphQL → `QueryBus` → `@QueryHandler` → MongoDB read model. One query per resolver method, no command, no PostgreSQL or write-model imports. Reuses the read-side `Order` type. | ✅ |
| III. Write flow | Untouched. | ✅ (n/a) |
| IV. Validation | `GetOrderArgs` is a `class-validator` DTO validated by the built-in `ValidationPipe`. Errors are mapped at the GraphQL boundary by the existing filter. No `any`. | ✅ |
| V/VI. Tests | Unit (handler found/not found, resolver, args), integration (real GraphQL plus MongoDB), and component (full stack). | ✅ |
| VII. Kafka | Not affected. | ✅ (n/a) |
| VIII. Branching | `feature/US-07-get-order-by-id` from an up-to-date `main`. Commits scoped `US-07`. | ✅ |
| IX. Quality gate | After every task. **Commit only when the gate exits 0** (process fix after US-06's `da6456d`). | ✅ (process) |
| Docs | Descriptions enforced by the schema test. `docs/schema.gql` regenerated. README example queries. `CLAUDE.md` read-path line. | ✅ |

**Post-design re-check**: still passes. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-get-order-by-id/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/graphql-order-query.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

New files are marked `+`, changed files `~`.

```text
src/
├── controllers/orders.resolver.ts        ~ + order(@Args() GetOrderArgs): OrderType | null
├── dto/graphql/get-order.args.ts         + @ArgsType: orderId ID! @IsUUID
├── queries/get-order.query.ts            + GetOrderQuery(orderId)
├── services/get-order.service.ts         + @QueryHandler: findById(lower-case id) → view | null
├── app.module.ts                         ~ register GetOrderService
└── read-model/order-view.repository.ts   (reused, unchanged: findById)

docs/schema.gql                           ~ regenerated (new `order` query)

tests/
├── unit/services/get-order.service.spec.ts             +
├── unit/dto/get-order.args.spec.ts                      +
├── unit/controllers/orders.resolver.spec.ts            ~ order(): dispatch, map, null
├── unit/graphql/schema.spec.ts                          ~ asserts order(orderId: ID!): Order
├── integration/list-orders.graphql.integration.spec.ts ~ "order by id" cases + outage case
│   (support/read-model-testing.ts ~ register GetOrderService)
└── component/list-orders.component.spec.ts             ~ order(orderId) through the full flow

README.md, CLAUDE.md, src/README.md, docs/read-model.md   ~ mention the `order` query
```

**Structure Decision**: Extend the US-06 read path in place (the same resolver, filter, type,
repository and test harnesses), as directed.

## Complexity Tracking

None.
