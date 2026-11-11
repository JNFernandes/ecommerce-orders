# Quickstart: validate List Orders over GraphQL (US-06)

The query contract is in [contracts/graphql-orders-query.md](contracts/graphql-orders-query.md).

## Prerequisites

- `../ecommerce-infra`: `docker compose up -d` (Kafka, Postgres, MongoDB).
- Optional: `../ecommerce-payments` running, so orders reach `CONFIRMED` or `CANCELLED`.
- `ecommerce-orders`: `npm ci`, with `.env` from `.env.example`.

## 1. Automated checks

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit          # handler, args validation, error filter, resolver mapping, schema drift + descriptions
npm run test:integration   # real GraphQL queries against a MongoDB container (filters, paging, errors, indexes)
npm run test:component     # REST → Postgres → Kafka → projection → MongoDB → GraphQL
npm run schema:generate && git diff --exit-code docs/schema.gql   # committed schema is current
```

## 2. Live

```bash
npm run start:dev
```

Open http://localhost:3000/graphql in a browser. The Apollo Sandbox should load, with the schema
and descriptions visible.

```bash
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ orders(limit: 5) { totalCount hasNextPage items { orderId status totalAmount placedAt } } }"}'
```

Expected: the newest 5 orders and a `totalCount` equal to
`db.order_views.countDocuments()` in MongoDB.

Place an order through `POST /orders` (see the README). Within a few seconds it is first in the
list; after the payment outcome its `status` becomes `CONFIRMED` or `CANCELLED`.

Filters and paging:

```graphql
{ orders(status: CANCELLED) { totalCount items { orderId cancellationReason } } }
{ orders(customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", limit: 2, offset: 2) { totalCount hasNextPage items { orderId } } }
```

Errors (each returns an `errors` entry and the service stays up):

```graphql
{ orders(limit: 0) { totalCount } }            # BAD_USER_INPUT (limit)
{ orders(offset: -1) { totalCount } }          # BAD_USER_INPUT (offset)
{ orders(customerId: "abc") { totalCount } }   # BAD_USER_INPUT (customerId)
{ orders(status: SHIPPED) { totalCount } }     # GRAPHQL_VALIDATION_FAILED
```

Indexes:

```bash
docker exec ecommerce-mongo-1 mongosh -u mongo_user -p mongo_pass --authenticationDatabase admin --quiet \
  orders_read --eval 'db.order_views.getIndexes().map(i => i.name)'
# [ '_id_', 'customerId_placedAt', 'status_placedAt', 'placedAt' ]
```

Production mode: `NODE_ENV=production node dist/main`. An introspection query is rejected, and
`GET /graphql` serves no sandbox.
