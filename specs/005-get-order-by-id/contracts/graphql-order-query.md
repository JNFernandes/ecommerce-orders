# Contract: GraphQL `order` query

**Endpoint**: `POST /graphql` (same API as the `orders` list, US-06).
**Source of data**: MongoDB read model `order_views`, looked up by order id (eventually consistent).

## Signature

```graphql
order(orderId: ID!): Order
```

`Order` is the existing type from US-06 (see `specs/004-list-orders-graphql/contracts/graphql-orders-query.md`).

## Found

```graphql
query GetOrder($orderId: ID!) {
  order(orderId: $orderId) {
    orderId customerId status totalAmount placedAt confirmedAt cancelledAt cancellationReason
    items { productId quantity unitPrice subtotal }
  }
}
```

Variables: `{ "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e" }`

```json
{
  "data": {
    "order": {
      "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e",
      "customerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "status": "CONFIRMED",
      "totalAmount": 39.98,
      "placedAt": "2026-11-11T20:41:17.578Z",
      "confirmedAt": "2026-11-11T20:41:17.737Z",
      "cancelledAt": null,
      "cancellationReason": null,
      "items": [{ "productId": "p-1", "quantity": 2, "unitPrice": 19.99, "subtotal": 39.98 }]
    }
  }
}
```

## Not found (valid UUID, no such order or not projected yet)

```json
{ "data": { "order": null } }
```

There is no `errors` key. This is a normal answer, not a failure.

## Malformed id

`{ order(orderId: "abc") { orderId } }`

```json
{ "errors": [{ "message": "orderId must be a UUID", "path": ["order"],
               "extensions": { "code": "BAD_USER_INPUT", "validationErrors": ["orderId must be a UUID"] } }],
  "data": { "order": null } }
```

## Missing argument

`{ order { orderId } }` → `GRAPHQL_VALIDATION_FAILED` (`Field "order" argument "orderId" of type "ID!" is required…`).

## Read model down

```json
{ "errors": [{ "message": "Order data is temporarily unavailable, please retry", "path": ["order"],
               "extensions": { "code": "SERVICE_UNAVAILABLE" } }], "data": { "order": null } }
```

## Telling "not found" from a failure

`order` is a **nullable** field, so when it fails GraphQL nulls just that field: the data is
`{ "order": null }` in both "not found" and failure cases. **The `errors` entry is what tells them
apart**: "not found" has none; a malformed id or an outage always has one. Clients must check
`errors` first. (Unlike `orders: OrdersPage!`, whose errors null the whole `data`.)

## Guarantees

- The same field values as the order's entry in `orders(...)`.
- The id is case-insensitive.
- Read-model bookkeeping (`appliedEventIds`, `statusEventId`, `revision`) is never exposed.
