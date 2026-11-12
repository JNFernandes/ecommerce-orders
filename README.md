# ecommerce-orders

The Orders microservice of the ecommerce platform. It owns the `Order` aggregate: it places,
confirms and cancels orders, stores them in PostgreSQL, and publishes order events to Kafka for
other services (Payments, and later Inventory and Notifications) to react to.

Built with NestJS and TypeScript, following DDD and CQRS. The rules this codebase must follow are
in the [project constitution](.specify/memory/constitution.md).

## Architecture

### Layers

Every request goes **Controller → Service → Domain → Repository**:

| Layer | Responsibility |
|---|---|
| Controller | HTTP I/O only: routing, DTO validation, response shaping. No logic. |
| Service | Orchestrates a command: calls the domain, then the repository, then Kafka. No business rules. |
| Domain | All business logic: the `Order` aggregate, the `OrderItem` value object, domain events and errors. No I/O. |
| Repository | Persistence. Maps domain objects to and from TypeORM entities. |

See [`src/README.md`](src/README.md) for the folder layout.

### CQRS

- **Write path (built)**: REST → `@nestjs/cqrs` command bus → service/command handler → domain →
  PostgreSQL (TypeORM). Only **after** the save succeeds is the Kafka event published. If the
  publish fails, the event goes to a dead-letter table and the request still succeeds; a
  background worker republishes it once Kafka is back (US-08).
- **Dead-letter retry (built, US-08)**: failed publishes and unprocessable consumed messages are
  retried automatically with capped exponential backoff, safely across instances, until they
  resolve or are marked `EXHAUSTED`. See [docs/dead-letter-retry.md](docs/dead-letter-retry.md).
- **Payment outcomes (built, US-04)**: a Kafka consumer reacts to `payments.payment-processed`
  and `payments.payment-failed` by dispatching the same Confirm/Cancel commands, so an order
  reaches `CONFIRMED` or `CANCELLED` with no manual call.
- **Read model (built, US-05)**: a projection consumes this service's own `orders.*` events and
  keeps one MongoDB document per order in `order_views` (see [docs/read-model.md](docs/read-model.md)).
- **Read path (built, US-06)**: GraphQL `orders` query → query bus → `ListOrdersService` →
  that **MongoDB** read model. It never touches PostgreSQL and is eventually consistent with the
  write side. See [GraphQL](#graphql-read-path) and
  [ADR 0001](docs/adr/0001-cqrs-read-model-in-orders-service.md). Queries: `orders` (list, US-06)
  and `order` (by id, US-07).

### Events

| Event | Topic | Direction | Status |
|---|---|---|---|
| `OrderPlaced` | `orders.order-placed` | Produced | Built |
| `OrderConfirmed` | `orders.order-confirmed` | Produced | Built |
| `OrderCancelled` | `orders.order-cancelled` | Produced | Built |
| `PaymentProcessed` | `payments.payment-processed` | Consumed: confirms the order | Built |
| `PaymentFailed` | `payments.payment-failed` | Consumed: cancels the order, stores the reason | Built |
| `orders.*` (own events) | `orders.*` | Consumed: builds the read model (`order_views`) | Built |

Every event carries `eventId`, `occurredAt`, `aggregateId` and `version`. Payment events
reference the order by `orderId`; their `aggregateId` is the payment id. Consumers dedupe by
`eventId`. The order/payment flow is a choreographed saga ([ADR 0003](docs/adr/0003-saga-by-choreography.md)).
Payload details are in [`docs/events/`](docs/events/).

### Payment outcome consumer

- Consumer group `KAFKA_GROUP_ID`. The order is looked up by the payment event's `orderId`.
- Idempotent: each handled `eventId` is stored in `processed_events`, in the same transaction as
  the status change, and a redelivery changes nothing.
- The offset is committed only after the outcome is saved. Malformed messages are dead-lettered
  immediately. Other failures (for example an unknown `orderId`) are retried with exponential
  backoff and then dead-lettered to `consumed_message_dead_letters`, from where the dead-letter
  worker retries them later (malformed ones are stored `EXHAUSTED` and never retried).
- `OrderCancelled` carries an optional `reason` when the cancellation came from a failed payment.
- Set `KAFKA_CONSUMER_ENABLED=false` to run the HTTP API without the consumers (payment and
  read-model projection).

## Endpoints

| Method | Path | Description | Responses |
|---|---|---|---|
| `POST` | `/orders` | Place an order (`customerId`, `items[]`) | `201` `{ orderId }`, `400` invalid input |
| `POST` | `/orders/:orderId/cancel` | Cancel a `PENDING` order | `200`, `404` not found, `409` not `PENDING` |
| `POST` | `/orders/:orderId/confirm` | Confirm a `PENDING` order manually (payment success does this automatically) | `200`, `404` not found, `409` not `PENDING` |

Swagger UI is served at `http://localhost:3000/api` while the app is running. Story-level details
are in [`docs/us-01-place-order.md`](docs/us-01-place-order.md),
[`docs/us-02-cancel-order.md`](docs/us-02-cancel-order.md) and
[`docs/us-03-confirm-order.md`](docs/us-03-confirm-order.md).

## GraphQL (read path)

`POST /graphql` serves the `orders` query from the MongoDB read model (eventually consistent:
a just-placed order may take a moment to appear). Outside production, open
`http://localhost:3000/graphql` in a browser for the Apollo Sandbox; with `NODE_ENV=production`
introspection and the sandbox are off. The schema is committed in
[`docs/schema.gql`](docs/schema.gql).

`orders(status, customerId, limit = 20, offset = 0): OrdersPage!` returns orders newest first
(`limit` 1–100, `offset` ≥ 0; `status` and `customerId` are optional and combine with AND), plus
`totalCount` and `hasNextPage`.

`order(orderId: ID!): Order` returns one order by id (any letter case), or `null` when no order
has that id. A just-placed order may briefly return `null` until it has been projected. "Not
found" is **not** an error: the response has no `errors` entry.

### Example GraphQL queries

Newest orders:

```graphql
{
  orders(limit: 5) {
    totalCount
    hasNextPage
    items { orderId customerId status totalAmount placedAt items { productId quantity subtotal } }
  }
}
```

Cancelled orders, with the reason:

```graphql
{ orders(status: CANCELLED) { totalCount items { orderId cancelledAt cancellationReason } } }
```

One customer's orders, second page of 10:

```graphql
{
  orders(customerId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", limit: 10, offset: 10) {
    totalCount
    hasNextPage
    items { orderId status placedAt confirmedAt }
  }
}
```

One order by id (variables shown as in Postman or the Sandbox):

```graphql
query GetOrder($orderId: ID!) {
  order(orderId: $orderId) {
    orderId status totalAmount placedAt confirmedAt cancelledAt cancellationReason
    items { productId quantity unitPrice subtotal }
  }
}
```

```json
{ "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e" }
```

An unknown id returns `{ "data": { "order": null } }` with no `errors`. A malformed id
(`order(orderId: "abc")`) returns `BAD_USER_INPUT` with `orderId must be a UUID`. Because `order`
is nullable, a failed lookup also comes back as `"data": { "order": null }`, so **check `errors`
first**: its presence is what separates a failure from "not found".

From the command line:

```bash
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ orders(limit: 5) { totalCount items { orderId status totalAmount } } }"}'
```

Invalid arguments return a GraphQL error (no crash), for example `{ orders(limit: 500) { totalCount } }`:

```json
{ "errors": [{ "message": "limit must not be greater than 100",
               "extensions": { "code": "BAD_USER_INPUT", "validationErrors": ["limit must not be greater than 100"] } }],
  "data": null }
```

An unknown `status` fails GraphQL validation (`GRAPHQL_VALIDATION_FAILED`); if MongoDB is down
the query returns `SERVICE_UNAVAILABLE`.

After changing resolvers, GraphQL types or descriptions, run `npm run schema:generate`. A unit
test fails while `docs/schema.gql` is out of date or any schema element lacks a description.

## Running locally

Prerequisites: Node.js 20, npm, Docker, and a checkout of the `ecommerce-infra` repo, which
provides the shared Kafka (KRaft, `localhost:9092`), PostgreSQL (`localhost:5432`) and MongoDB
(`localhost:27017`).

```bash
# 1. Start the shared infrastructure (in the ecommerce-infra repo)
docker compose up -d

# 2. In this repo
npm ci
cp .env.example .env
npm run migration:run      # create/upgrade the orders schema in PostgreSQL
npm run seed:customers     # seed customers for local testing
npm run start:dev          # http://localhost:3000, Swagger at /api
```

### Docker image

```bash
docker build -t ecommerce-orders .
```

The image runs `node dist/main` as the non-root `node` user. It is not part of any compose file;
when you run it, pass the environment variables below. Inside a container, `localhost` is the
container itself, so point `DB_HOST` and `KAFKA_BROKERS` at hosts the container can reach.

## Environment variables

| Variable | Default (`.env.example`) | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USERNAME` | `orders_user` | PostgreSQL user |
| `DB_PASSWORD` | `orders_pass` | PostgreSQL password |
| `DB_NAME` | `orders` | PostgreSQL database |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka brokers |
| `KAFKA_CLIENT_ID` | `ecommerce-orders` | Kafka client id |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `1000` | Timeout for opening a broker connection |
| `KAFKA_PRODUCER_RETRIES` | `1` | Producer connect/publish retries before the event is dead-lettered (bounds a failed publish to about 3 s) |
| `KAFKA_GROUP_ID` | `ecommerce-orders-consumer` | Consumer group id of the payment events consumer |
| `KAFKA_PROJECTION_GROUP_ID` | `ecommerce-orders-projection` | Consumer group of the read-model projection |
| `MONGO_URI` | `mongodb://mongo_user:mongo_pass@localhost:27017/orders_read?authSource=admin` | Read-model database (MongoDB) |
| `KAFKA_CONSUMER_ENABLED` | `true` | Start both Kafka consumers (`false` disables them) |
| `PAYMENT_CONSUMER_MAX_ATTEMPTS` | `5` | Attempts before a failing event is dead-lettered (both consumers) |
| `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS` | `1000` | First retry delay (doubles each attempt) |
| `PAYMENT_CONSUMER_BACKOFF_MAX_MS` | `30000` | Maximum retry delay |
| `DEAD_LETTER_RETRY_ENABLED` | `true` | Run the dead-letter retry worker (`false` disables it) |
| `DEAD_LETTER_RETRY_INTERVAL_MS` | `30000` | Pause between retry cycles |
| `DEAD_LETTER_BATCH_SIZE` | `20` | Maximum rows retried per store per cycle |
| `DEAD_LETTER_BASE_DELAY_MS` | `5000` | Delay after the first failed retry (doubles each time) |
| `DEAD_LETTER_MAX_DELAY_MS` | `600000` | Maximum delay between retries |
| `DEAD_LETTER_MAX_RETRIES` | `8` | Retries before a dead letter is marked `EXHAUSTED` |

MongoDB is connected lazily: the HTTP API and the payment consumer start and keep working while
it is down, and the projection catches up once it is back.

**Startup does not require Kafka.** Nothing connects to Kafka during bootstrap:

- The producer connects on the first publish. While Kafka is down, `POST /orders` (and
  confirm/cancel) still succeed within about 3 s, and the event goes to `order_dead_letters`.
  The [dead-letter worker](docs/dead-letter-retry.md) publishes it once Kafka is back.
- Both consumers connect in the background. A failed connect is retried with capped exponential
  backoff (`PAYMENT_CONSUMER_BACKOFF_*`) until it succeeds or the service shuts down.
- The logs show one warning per failed attempt ("Kafka is unreachable") and one line when it
  recovers ("Kafka is available again"). kafkajs's own per-retry connection errors are
  throttled to one line per broker per minute.

## Tests

```bash
npm run test               # all test projects
npm run test:unit          # domain and handlers in isolation (no Nest, DB or Kafka)
npm run test:integration   # REST + payment consumer (real PostgreSQL); read model and GraphQL queries (real MongoDB)
npm run test:component     # full Nest app (REST → Kafka → projection → GraphQL) on real PostgreSQL, Kafka and MongoDB
npm run schema:generate    # regenerate docs/schema.gql after GraphQL changes
npm run test:cov           # with coverage
```

Integration and component tests start containers via testcontainers, so Docker must be running.

Quality gate, run after every task and before every commit:

```bash
npm run build && npm run lint && npm run format:check && npm run test
```

## Documentation

- [Project constitution](.specify/memory/constitution.md): the non-negotiable rules
- [Read model](docs/read-model.md): document shape, projection rules, indexes, rebuild
- [GraphQL schema](docs/schema.gql): generated SDL of the read API
- [Architecture Decision Records](docs/adr/)
- [Event contracts](docs/events/)
- [Source layout](src/README.md)
