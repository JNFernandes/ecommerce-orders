# Quickstart: validate US-12

Prereqs: Docker running (testcontainers); for the manual run, `ecommerce-infra` up and
`ecommerce-identity` reachable at `IDENTITY_JWKS_URL`.

## Automated

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit         # scope construction, scopeOrderFilter, both handlers
npm run test:integration  # scoped list/count/by-id + explain() on real MongoDB
npm run test:component    # full app, signed tokens via withTestIdentity()
npm run schema:generate && git diff --exit-code docs/schema.gql  # descriptions only
```

Expected: all green; component suite covers every row of
[contracts/graphql-scoping.md](contracts/graphql-scoping.md).

## Manual

1. `npm run start:dev`; register customers A and B in Identity, log in as each, place orders.
2. As A: `{ orders { totalCount items { orderId customerId } } }` → only A's orders.
3. As A: `{ orders(customerId: "<B>") { totalCount items { orderId } } }` → `totalCount: 0`.
4. As A: `{ order(orderId: "<B's order>") { orderId } }` → `{"data":{"order":null}}`, no `errors`.
5. As an admin: `orders` returns A's and B's orders; `orders(customerId: "<B>")` only B's.
6. Without `Authorization`: `UNAUTHENTICATED`.
