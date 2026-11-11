# Data Model: List Orders over GraphQL (US-06)

Phase 1 output for [plan.md](plan.md). This feature reads the existing US-05 read model. The only
storage change is new **indexes**; no document fields change.

## MongoDB `order_views`: new indexes

| Name | Keys | Serves |
|---|---|---|
| `customerId_placedAt` | `{ customerId: 1, placedAt: -1, _id: -1 }` | `orders(customerId: …)`, with or without `status` |
| `status_placedAt` | `{ status: 1, placedAt: -1, _id: -1 }` | `orders(status: …)` |
| `placedAt` | `{ placedAt: -1, _id: -1 }` | `orders` with no filter |

These are declared on `OrderViewSchema` and created by `OrderViewRepository.ensureIndexes()` once
the connection is up (`autoIndex: false`, see research R7). Creation is idempotent.

## Read-side query contract (`src/read-model/order-view.repository.ts`)

```ts
interface OrderViewFilter { status?: OrderViewStatus; customerId?: string }
interface PageRequest     { limit: number; offset: number }   // already validated
interface OrderViewPage   { views: OrderView[]; totalCount: number }

list(filter: OrderViewFilter, page: PageRequest): Promise<OrderViewPage>
// sort { placedAt: -1, _id: -1 }; nulls last; ReadModelUnavailableError on outage
ensureIndexes(): Promise<void>
```

## Application query (`src/queries/`, `src/services/`)

| Type | Fields |
|---|---|
| `ListOrdersQuery` | `filter: OrderViewFilter`, `page: PageRequest` |
| `ListOrdersResult` (returned by `ListOrdersService`) | `views: OrderView[]`, `totalCount: number`, `hasNextPage: boolean` (`offset + views.length < totalCount`) |

## GraphQL types (`src/dto/graphql/`)

All are code-first classes, separate from TypeORM entities, the `Order` aggregate and the Mongoose
schema. Every type, field, argument and enum value carries a `description`.

### `enum OrderStatus` (registered from read-side `OrderViewStatus`)

| Value | Description |
|---|---|
| `PENDING` | Placed, waiting for the payment outcome |
| `CONFIRMED` | Payment succeeded |
| `CANCELLED` | Cancelled (payment failed or cancelled through the API) |

### `type OrderItem`

| Field | GraphQL type | From `OrderItemView` |
|---|---|---|
| `productId` | `String!` | `productId` |
| `quantity` | `Int!` | `quantity` |
| `unitPrice` | `Float!` | `unitPrice` |
| `subtotal` | `Float!` | `subtotal` |

### `type Order`

| Field | GraphQL type | From `OrderView` | Null when |
|---|---|---|---|
| `orderId` | `ID!` | `orderId` | never |
| `customerId` | `ID!` | `customerId` | never |
| `status` | `OrderStatus!` | `status` | never |
| `items` | `[OrderItem!]` | `items` | `OrderPlaced` not projected yet |
| `totalAmount` | `Float` | `totalAmount` | likewise |
| `placedAt` | `DateTime` | `placedAt` | likewise |
| `confirmedAt` | `DateTime` | `confirmedAt` | not `CONFIRMED` |
| `cancelledAt` | `DateTime` | `cancelledAt` | not `CANCELLED` |
| `cancellationReason` | `String` | `cancellationReason` | no reason given |

`appliedEventIds`, `statusEventId`, `revision` and `updatedAt` are **not** exposed (FR-008: internal
bookkeeping; `updatedAt` is not in the requested field list).

### `type OrdersPage`

| Field | GraphQL type |
|---|---|
| `items` | `[Order!]!` |
| `totalCount` | `Int!` |
| `hasNextPage` | `Boolean!` |

### `ListOrdersArgs` (`@ArgsType`)

| Arg | GraphQL type | Default | Validation (`class-validator`) |
|---|---|---|---|
| `status` | `OrderStatus` | – | `@IsOptional() @IsEnum(OrderViewStatus)` (GraphQL enum coercion rejects unknown values first) |
| `customerId` | `ID` | – | `@IsOptional() @IsUUID()` |
| `limit` | `Int` | `20` | `@IsInt() @Min(1) @Max(100)` |
| `offset` | `Int` | `0` | `@IsInt() @Min(0)` |

## Errors (GraphQL `extensions.code`)

| Situation | Code | Message |
|---|---|---|
| `limit`, `offset` or `customerId` invalid | `BAD_USER_INPUT` | the validation message(s), e.g. `limit must not be greater than 100`; the list is in `extensions.validationErrors` |
| unknown `status` literal | `GRAPHQL_VALIDATION_FAILED` | `Value "SHIPPED" does not exist in "OrderStatus" enum…` |
| unknown `status` passed as a variable | `BAD_USER_INPUT` | `Variable "$status" got invalid value…` |
| read model unreachable | `SERVICE_UNAVAILABLE` | `Order data is temporarily unavailable, please retry` |

## Configuration

| Key | Source | Meaning |
|---|---|---|
| `graphql.devTools` | `NODE_ENV !== 'production'` | Enables introspection and the Apollo Sandbox landing page |
