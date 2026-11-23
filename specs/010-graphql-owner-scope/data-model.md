# Data Model: US-12

No new collection, no projection change, no migration. Every `order_views` document already has
`customerId`.

## OrderReadScope (value object, `src/queries/order-read-scope.ts`)

| Variant | Fields | Built when (effective roles) |
|---|---|---|
| `ALL` | — | `ADMIN` (with or without `customerId`) |
| `CUSTOMER` | `customerId` (lowercased UUID) | `CUSTOMER` with `customerId`, no `ADMIN` |
| — (throws `ReadScopeForbiddenError`) | — | neither |

Immutable; only factory `forCaller(claims)`.

## Queries (changed)

- `ListOrdersQuery(scope: OrderReadScope, filter: OrderViewFilter, page: PageRequest)`
- `GetOrderQuery(scope: OrderReadScope, orderId: string)`

`scope` is required (first argument).

## Scoping rule (`scopeOrderFilter`, `src/read-model/order-view-scope.ts`, pure)

| Scope | Requested `customerId` | Effective filter |
|---|---|---|
| `ALL` | any / none | requested filter unchanged |
| `CUSTOMER(c)` | none or `c` | requested filter + `customerId = c` |
| `CUSTOMER(c)` | `d ≠ c` | `EMPTY` (no query, `{ views: [], totalCount: 0 }`) |

By id: `ALL` → `{ _id }`; `CUSTOMER(c)` → `{ _id, customerId: c }`.

## Index (`OrderViewSchema`)

| Name | Keys | Serves |
|---|---|---|
| `customerId_placedAt` (existing) | `customerId 1, placedAt -1, _id -1` | owner list/count |
| `customerId_status_placedAt` (new) | `customerId 1, status 1, placedAt -1, _id -1` | owner + status list/count |
| `_id` (default) | `_id` | scoped by-id |
