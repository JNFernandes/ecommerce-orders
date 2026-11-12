# Quickstart: validate Get Order by Id (US-07)

The contract is in [contracts/graphql-order-query.md](contracts/graphql-order-query.md).

## Automated

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit          # GetOrderService (found / not found / case), resolver, args, schema drift + descriptions
npm run test:integration   # real GraphQL `order` queries against a MongoDB container
npm run test:component     # REST → Kafka → projection → MongoDB → GraphQL order(orderId)
npm run schema:generate && git diff --exit-code docs/schema.gql
```

## Live (ecommerce-infra up; Payments optional)

```bash
npm run start:dev
ID=$(curl -s -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customerId":"3fa85f64-5717-4562-b3fc-2c963f66afa6","items":[{"productId":"p-1","quantity":2,"unitPrice":10}]}' \
  | sed 's/.*"orderId":"\([^"]*\)".*/\1/')

curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d "{\"query\":\"{ order(orderId: \\\"$ID\\\") { orderId status totalAmount confirmedAt } }\"}"
```

Expected: the order, `PENDING` at first (or briefly `null` until it is projected), then
`CONFIRMED` (≤ 10000) or `CANCELLED` with `cancellationReason` (> 10000) once Payments answers.

| Try | Expected |
|---|---|
| `order(orderId: "00000000-0000-4000-8000-000000000000")` | `{"data":{"order":null}}` with no `errors` |
| `order(orderId: "abc")` | `BAD_USER_INPUT`, `orderId must be a UUID` |
| `order { orderId }` | `GRAPHQL_VALIDATION_FAILED` (argument required) |
| the same id in UPPERCASE | the same order |

In the Apollo Sandbox (`http://localhost:3000/graphql`) or Postman (New → GraphQL), the `order`
query appears next to `orders` with its description.
