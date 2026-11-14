# Quickstart: Validate US-09

## Prerequisites

- Docker running; `ecommerce-infra` up (`docker compose up -d` there): Kafka `localhost:9092`,
  PostgreSQL `localhost:5432`, MongoDB `localhost:27017`. The `inventory.*` topics are created
  by `kafka-init`.
- In this repo: `npm ci`, `cp .env.example .env` (now includes `KAFKA_INVENTORY_GROUP_ID`).

## 1. Automated checks

```bash
npm run build && npm run lint && npm run format:check && npm run test
```

Expected: all pass. The suites that prove the feature:

| Suite | Proves |
|---|---|
| `tests/unit/domain/order-outcomes.spec.ts` | Every arrival order of the four outcomes, repeats, late outcomes, reasons (data-model transition tables) |
| `tests/unit/services/apply-*-outcome.service.spec.ts` | Write flow: save then publish, dead-letter on publish failure, log levels |
| `tests/unit/infra/stock-message.parser.spec.ts` | `orderId` used, `aggregateId` → `reservationId`, malformed cases |
| `tests/integration/order-outcomes-migration.integration.spec.ts` | Columns, defaults, backfill, `down()` |
| `tests/integration/inventory-events.integration.spec.ts` | Consumer on real PostgreSQL, including concurrent outcomes |
| `tests/component/order-outcomes.component.spec.ts` | Both consumers end to end on real Kafka and PostgreSQL |

## 2. Manual run

```bash
npm run migration:run        # adds paymentOutcome / stockOutcome, backfills CONFIRMED orders
npm run start:dev
```

Place an order and keep its id:

```bash
curl -s localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customerId":"<seeded customer id>","items":[{"productId":"sku-1","quantity":1,"unitPrice":10}]}'
```

If Payments and Inventory are running, they react to `OrderPlaced` by themselves. Otherwise,
publish the outcomes by hand (kafka-ui, or `kafka-console-producer` in the Kafka container) using
the examples in [contracts/event-stock-reserved.md](contracts/event-stock-reserved.md) and
`docs/events/payment-processed.md`, with fresh `eventId`s and the order's id as `orderId`.

| Scenario | Publish | Expected |
|---|---|---|
| Payment first | `payments.payment-processed`, then `inventory.stock-reserved` | `PENDING` after the first; `CONFIRMED` and one message on `orders.order-confirmed` after the second |
| Stock first | the same two in the opposite order | same result |
| Stock rejected | `inventory.stock-rejected` with `reason: "insufficient stock"` | `CANCELLED`; `orders.order-cancelled` with `reason: "stock rejected: insufficient stock"` |
| Late payment | `payments.payment-processed` for that cancelled order | no change, no event; a log warning starting `payment needs refund:` |
| Reservation id ≠ order id | any stock message with a random `aggregateId` | the order named by `orderId` is the one updated |
| Malformed | `inventory.stock-reserved` with `"orderId": "abc"` | a row in `consumed_message_dead_letters` with status `EXHAUSTED`; the next message is processed |

Check the order with GraphQL (`order(orderId)` returns its status; the outcomes are not exposed)
or in PostgreSQL:

```sql
SELECT status, "paymentOutcome", "stockOutcome", "cancellationReason" FROM orders WHERE id = '<id>';
```

## 3. Startup without Kafka

Stop Kafka and start the service: it starts, `POST /orders` succeeds, and the logs show one
"Kafka is unreachable" warning per attempt for each consumer, including the inventory consumer.
