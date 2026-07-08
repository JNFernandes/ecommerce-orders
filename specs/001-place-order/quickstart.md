# Quickstart: Validate "Place an Order"

## Prerequisites

- Node.js 20 LTS, npm
- Docker (for PostgreSQL + Kafka via `docker-compose`)
- Repo dependencies installed: `npm install`
- `docker-compose up -d` to start PostgreSQL and Kafka
- Write-DB migrations run (creates `orders`, `order_items`, `customers`, `order_dead_letters`) and at least one seed row in `customers` for a test customer id (see data-model.md)

## Start the service

```
npm run start:dev
```

## Scenario 1 — Place a valid order (US-01, AC-01)

```
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "<seeded-customer-uuid>",
    "items": [{ "productId": "prod-001", "quantity": 2, "unitPrice": 29.99 }]
  }'
```

**Expected**: `201 Created` with `{ "orderId": "<uuid>" }` (contracts/rest-place-order.md). Confirm the order exists in the `orders`/`order_items` tables with `status = PENDING` and `totalAmount = 59.98`.

## Scenario 2 — Duplicate product entries are consolidated (FR-006)

Same as Scenario 1, but submit two items with the same `productId` and different quantities. Expect a single `order_items` row for that product with the summed quantity, and `totalAmount` computed from the consolidated quantity.

## Scenario 3 — Unknown customer is rejected (AC-02a)

Repeat Scenario 1 with a `customerId` that is a valid UUID but not seeded in `customers`. Expect `404 Not Found` (`"Customer not found"`) and no row created in `orders`.

## Scenario 4 — Invalid input is rejected (AC-02)

Repeat Scenario 1 with an empty `items` array, or a `quantity`/`unitPrice` of `0`. Expect `400 Bad Request` with a message identifying the invalid field(s), and no row created in `orders`.

## Scenario 5 — OrderPlaced actually reaches Kafka

This service is a Kafka producer only — there is no consumer or read model in this repo (a future, separate read-side service owns that). To confirm the event actually reaches the broker after Scenario 1, inspect the topic directly, e.g.:

```
docker exec ecommerce-orders-kafka-1 kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic orders.order-placed \
  --from-beginning \
  --max-messages 1
```

Expect one JSON message matching the `OrderPlaced` payload shape (contracts/event-order-placed.md), with `aggregateId` equal to the `orderId` returned in Scenario 1.

## Scenario 6 — Kafka publish failure never surfaces as a client error (AC-03)

In a component test, stop/mock the Kafka producer to force a publish failure after the DB save succeeds. Expect the client still receives `201 Created`, and a row appears in `order_dead_letters` with the failed event's payload and error.

## Where to look next

- Full request/response contract: `contracts/rest-place-order.md`
- Kafka event schema: `contracts/event-order-placed.md`
- Entities and validation rules: `data-model.md`
- Design decisions (customer lookup, read-model shape, dead-letter handling, test infra): `research.md`
