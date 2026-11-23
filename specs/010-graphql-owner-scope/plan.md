# Implementation Plan: Scope the GraphQL Read Model by Owner (US-12)

**Branch**: `feature/US-12-graphql-owner-scope` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

## Summary

Resolvers turn the verified claims into a required `OrderReadScope` (ALL for admins, CUSTOMER(id)
for customers, FORBIDDEN otherwise) and pass it in `ListOrdersQuery` / `GetOrderQuery`. Handlers
apply it through the pure `scopeOrderFilter` into the MongoDB filter of list, count and by-id; a
conflicting `customerId` yields an empty page. New owner+status index via `ensureIndexes()`.
Details: [research.md](research.md), [data-model.md](data-model.md),
[contracts/graphql-scoping.md](contracts/graphql-scoping.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js, NestJS 10
**Primary Dependencies**: `@nestjs/cqrs`, `@nestjs/graphql` (Apollo), `@nestjs/mongoose`, `jose` 5.10
**Storage**: MongoDB `order_views` (read only; no write-side change)
**Testing**: Jest, Supertest, testcontainers (MongoDB, PostgreSQL), `withTestIdentity()`
**Target Platform**: Linux container
**Project Type**: web service (single project)
**Performance Goals**: scoped queries index-backed (IXSCAN, no COLLSCAN)
**Constraints**: no schema shape change; no token in logs/errors; read model must not import `src/domain`
**Scale/Scope**: 2 queries, 2 handlers, 1 resolver, 1 index

## Constitution Check

| Principle | Status |
|---|---|
| I Layering | ✅ resolver reads claims + dispatches; handlers orchestrate; rule is pure (`scopeOrderFilter`) |
| II CQRS | ✅ query bus only; Mongo only; read model doesn't import `src/domain` (mirrors `isAccessibleBy`, not reuses it) |
| III Write flow | ✅ untouched |
| IV Types/validation | ✅ discriminated union, no `any`; existing `ListOrdersArgs`/`GetOrderArgs` validation |
| V/VI Tests | ✅ unit (scope, rule, handlers), integration (real Mongo), component (full app, signed tokens) |
| VII Kafka | ✅ n/a |
| IX Quality gate | ✅ build → lint → format:check → test per task |
| Docs | ✅ JSDoc, GraphQL descriptions, README, `docs/read-model.md`, regenerated `docs/schema.gql` |

Post-design re-check: no violations. Complexity Tracking: none.

## Project Structure

```text
specs/010-graphql-owner-scope/  plan.md research.md data-model.md quickstart.md contracts/

src/
├── queries/
│   ├── order-read-scope.ts          # NEW OrderReadScope + forCaller + ReadScopeForbiddenError
│   ├── list-orders.query.ts         # + scope
│   └── get-order.query.ts           # + scope
├── read-model/
│   ├── order-view-scope.ts          # NEW pure scopeOrderFilter / EMPTY
│   ├── order-view.repository.ts     # + findOne(orderId, customerId?)
│   └── order-view.schema.ts         # + customerId_status_placedAt index
├── services/
│   ├── list-orders.service.ts       # apply scope; EMPTY → empty page, no DB call
│   └── get-order.service.ts         # scoped findOne
├── controllers/orders.resolver.ts   # @CurrentUser → scope → query; updated descriptions
└── graphql/graphql-user-input.filter.ts  # ReadScopeForbiddenError → FORBIDDEN

tests/
├── unit/queries/order-read-scope.spec.ts           # admin, customer, admin+customer, no customerId, no roles, lowercasing
├── unit/read-model/order-view-scope.spec.ts        # ALL, own id, conflicting id, + status
├── unit/services/{list-orders,get-order}.service.spec.ts  # customer, admin, conflicting filter, foreign id → null
├── integration/order-view.repository.integration.spec.ts  # scoped list/count/paging, by-id, new index, explain()
└── component/graphql-owner-scope.component.spec.ts  # A only A (+totals, paging, status), A→B by id null,
                                                     # A filter B empty, admin all + filter, no customerId
                                                     # & no ADMIN → FORBIDDEN, no token → UNAUTHENTICATED

README.md  # access table row, "who sees what" + GraphQL examples; drop "not scoped until US-12"
docs/read-model.md, docs/schema.gql
```

**Structure Decision**: existing single project; changes confined to the read path above.

## Notes

- "No token gets 401": GraphQL answers `UNAUTHENTICATED` with HTTP 200 (US-11 contract); the
  component test asserts that, not a 401 status.
- Existing `tests/integration/list-orders.graphql.integration.spec.ts` and
  `tests/component/list-orders.component.spec.ts` must pass a scoped caller (admin) to keep SC-004.
