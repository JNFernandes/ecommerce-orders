# Contract: GraphQL `orders` query

**Endpoint**: `POST /graphql` (GraphQL over HTTP, JSON). Outside production, `GET /graphql` in a
browser serves the Apollo Sandbox.
**Source of data**: MongoDB read model `order_views` (eventually consistent with the write side).
**Auth**: none (out of scope).

## Expected SDL (excerpt; the full schema is generated into `docs/schema.gql`)

```graphql
"""An order as seen by the read model (eventually consistent with the write side)."""
type Order {
  """Order identifier (UUID)."""
  orderId: ID!
  """Customer who placed the order (UUID)."""
  customerId: ID!
  """Current lifecycle status."""
  status: OrderStatus!
  """Line items; null until the order-placed event has been projected."""
  items: [OrderItem!]
  """Order total; null until the order-placed event has been projected."""
  totalAmount: Float
  """When the order was placed; null until the order-placed event has been projected."""
  placedAt: DateTime
  """When the order was confirmed; null unless status is CONFIRMED."""
  confirmedAt: DateTime
  """When the order was cancelled; null unless status is CANCELLED."""
  cancelledAt: DateTime
  """Why the order was cancelled (e.g. payment failure reason); null when none was given."""
  cancellationReason: String
}

type Query {
  """Lists orders from the read model, newest first (orders without a placement time last)."""
  orders(
    """Only orders in this status."""
    status: OrderStatus
    """Only orders of this customer (UUID)."""
    customerId: ID
    """Page size, 1–100."""
    limit: Int! = 20
    """Number of orders to skip, ≥ 0."""
    offset: Int! = 0
  ): OrdersPage!
}
```

`OrderItem`, `OrdersPage` and the `OrderStatus` enum are as in [data-model.md](../data-model.md).
Every type, field, argument and enum value has a description; the unit tests check this.

## Example: newest confirmed orders of one customer

```graphql
query {
  orders(customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", status: CONFIRMED, limit: 2) {
    totalCount
    hasNextPage
    items { orderId status totalAmount placedAt confirmedAt items { productId quantity subtotal } }
  }
}
```

```json
{
  "data": {
    "orders": {
      "totalCount": 3,
      "hasNextPage": true,
      "items": [
        {
          "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e",
          "status": "CONFIRMED",
          "totalAmount": 39.98,
          "placedAt": "2026-11-11T20:41:17.578Z",
          "confirmedAt": "2026-11-11T20:41:17.737Z",
          "items": [{ "productId": "p-1", "quantity": 2, "subtotal": 39.98 }]
        },
        { "…": "second order" }
      ]
    }
  }
}
```

## Example: invalid limit

```graphql
query { orders(limit: 500) { totalCount } }
```

```json
{
  "errors": [{
    "message": "limit must not be greater than 100",
    "path": ["orders"],
    "extensions": { "code": "BAD_USER_INPUT", "validationErrors": ["limit must not be greater than 100"] }
  }],
  "data": null
}
```

## Example: unknown status

```graphql
query { orders(status: SHIPPED) { totalCount } }
```

```json
{ "errors": [{ "message": "Value \"SHIPPED\" does not exist in \"OrderStatus\" enum. …",
               "extensions": { "code": "GRAPHQL_VALIDATION_FAILED" } }] }
```

## Example: read model down

```json
{ "errors": [{ "message": "Order data is temporarily unavailable, please retry",
               "path": ["orders"], "extensions": { "code": "SERVICE_UNAVAILABLE" } }],
  "data": null }
```

## Guarantees

- Sorted by `placedAt` descending, then `orderId` descending. Orders with `placedAt: null` come last.
- `totalCount` counts all orders matching the filters. `hasNextPage` ⇔ `offset + items.length < totalCount`.
- Read-model bookkeeping (`appliedEventIds`, `statusEventId`, `revision`) is never exposed.
- Introspection and the sandbox are **off** when `NODE_ENV=production`.
