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
  publish fails, the event goes to a dead-letter table and the request still succeeds.
- **Read path (planned)**: GraphQL → query bus → query handlers → a **MongoDB** read model, kept
  up to date by a projection that consumes this service's own Kafka events. It is eventually
  consistent with the write side. See [ADR 0001](docs/adr/0001-cqrs-read-model-in-orders-service.md).

### Events

| Event | Topic | Direction | Status |
|---|---|---|---|
| `OrderPlaced` | `orders.order-placed` | Produced | Built |
| `OrderConfirmed` | `orders.order-confirmed` | Produced | Built |
| `OrderCancelled` | `orders.order-cancelled` | Produced | Built |
| `PaymentProcessed` | `payments.payment-processed` | Consumed: confirms the order | Planned |
| `PaymentFailed` | `payments.payment-failed` | Consumed: cancels the order | Planned |
| `orders.*` (own events) | `orders.*` | Consumed: builds the read model | Planned |

Every event carries `eventId`, `occurredAt`, `aggregateId` and `version`. Payment events
reference the order by `orderId`; their `aggregateId` is the payment id. Consumers dedupe by
`eventId`. The order/payment flow is a choreographed saga ([ADR 0003](docs/adr/0003-saga-by-choreography.md)).
Payload details are in [`docs/events/`](docs/events/).

## Endpoints

| Method | Path | Description | Responses |
|---|---|---|---|
| `POST` | `/orders` | Place an order (`customerId`, `items[]`) | `201` `{ orderId }`, `400` invalid input |
| `POST` | `/orders/:orderId/cancel` | Cancel a `PENDING` order | `200`, `404` not found, `409` not `PENDING` |
| `POST` | `/orders/:orderId/confirm` | Confirm a `PENDING` order | `200`, `404` not found, `409` not `PENDING` |

Swagger UI is served at `http://localhost:3000/api` while the app is running. Story-level details
are in [`docs/us-01-place-order.md`](docs/us-01-place-order.md),
[`docs/us-02-cancel-order.md`](docs/us-02-cancel-order.md) and
[`docs/us-03-confirm-order.md`](docs/us-03-confirm-order.md).

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
npm run migration:run      # create the orders schema in PostgreSQL
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
| `KAFKA_GROUP_ID` | `ecommerce-orders-consumer` | Consumer group id, reserved for the planned consumers |

MongoDB settings will be added together with the read model; the service does not connect to
MongoDB yet.

## Tests

```bash
npm run test               # all test projects
npm run test:unit          # domain and handlers in isolation (no Nest, DB or Kafka)
npm run test:integration   # REST endpoints against a real PostgreSQL, Kafka producer mocked
npm run test:component     # full Nest app against real PostgreSQL and Kafka containers
npm run test:cov           # with coverage
```

Integration and component tests start containers via testcontainers, so Docker must be running.

Quality gate, run after every task and before every commit:

```bash
npm run build && npm run lint && npm run format:check && npm run test
```

## Documentation

- [Project constitution](.specify/memory/constitution.md): the non-negotiable rules
- [Architecture Decision Records](docs/adr/)
- [Event contracts](docs/events/)
- [Source layout](src/README.md)
