# Data Model: Get Order by Id over GraphQL (US-07)

Phase 1 output for [plan.md](plan.md). **No storage change**: no new collection, field, index or
migration. The lookup uses the `order_views` primary key (`_id` = order id).

## Reused (unchanged)

| Piece | Location | Role here |
|---|---|---|
| `OrderViewRepository.findById(orderId)` | `src/read-model/order-view.repository.ts` | Lookup by `_id`; returns `{ view, revision }` or `null`; an outage throws `ReadModelUnavailableError` |
| `OrderType` (GraphQL `Order`) and `OrderType.fromView` | `src/dto/graphql/order.type.ts` | Result type and mapping (no bookkeeping fields) |
| `OrdersResolver` | `src/controllers/orders.resolver.ts` | Gains the `order` method |
| `GraphQLUserInputFilter` | `src/graphql/graphql-user-input.filter.ts` | `BAD_USER_INPUT` / `SERVICE_UNAVAILABLE` |
| `buildGraphqlOptions`, `configureApp` | `src/graphql/`, `src/app.setup.ts` | Unchanged |

## New

### `GetOrderArgs` (`@ArgsType`, `src/dto/graphql/get-order.args.ts`)

| Arg | GraphQL type | Validation | Description |
|---|---|---|---|
| `orderId` | `ID!` | `@IsUUID()` | Order identifier (UUID, any case). |

### `GetOrderQuery` (`src/queries/get-order.query.ts`)

| Field | Type |
|---|---|
| `orderId` | `string` (validated UUID, any case) |

### `GetOrderService` (`@QueryHandler(GetOrderQuery)`, `src/services/get-order.service.ts`)

`execute(query) → Promise<OrderView | null>` = `(await repository.findById(query.orderId.toLowerCase()))?.view ?? null`

### GraphQL schema addition

```graphql
type Query {
  """
  Gets one order from the read model by id, or null when no order has that id. Eventually
  consistent: an order that was just placed may briefly return null until it has been projected.
  """
  order(
    """Order identifier (UUID, any case)."""
    orderId: ID!
  ): Order
  # orders(...) unchanged
}
```

## Outcomes

| Request | Response |
|---|---|
| Existing id (any case) | `{ "data": { "order": { … } } }` |
| Unknown valid UUID | `{ "data": { "order": null } }` with **no** `errors` key |
| `orderId: "abc"` | `errors[0].extensions.code = BAD_USER_INPUT`, message `orderId must be a UUID`, `data: { order: null }` |
| `orderId` missing | `GRAPHQL_VALIDATION_FAILED` (`ID!` required) |
| Read model unreachable | `SERVICE_UNAVAILABLE`, generic message, `data: { order: null }` |

`order` is nullable, so an error nulls only that field; the presence of `errors` is what distinguishes a failure from "not found".
