# Quickstart: validate React to Payment Outcome (US-04)

A run-and-check guide that proves the feature works end to end. Contracts are in
[contracts/](contracts/) and tables in [data-model.md](data-model.md).

## Prerequisites

- Docker running.
- `../ecommerce-infra`: `docker compose up -d`. This starts Kafka on `localhost:9092`
  (topics pre-created by `kafka-init`, 3 partitions each, auto-create **disabled**) and Postgres
  for orders on `localhost:5432`.
- `../ecommerce-payments` built (`dotnet run --project src/Ecommerce.Payments.Consumer`). Its
  default `PaymentPolicy:MaxAmountThreshold` is `10000.00`.
- `ecommerce-orders`: `npm ci`, `.env` copied from `.env.example`.

## 1. Automated checks

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit                       # policy, DTOs, backoff, services, consumer handler
npm run test:integration                # real Postgres; includes react-to-payment-outcome
npm run test:component                  # real Kafka + Postgres; includes react-to-payment-outcome
```

Expected: everything passes, and the existing confirm/cancel suites pass unchanged (SC-006).

## 2. End-to-end against the shared infrastructure

```bash
npm run migration:run       # adds orders.cancellationReason, processed_events, consumed_message_dead_letters
npm run seed:customers
npm run start:dev           # log should show the payment consumer joining group ecommerce-orders-consumer
```

Start Payments in a second terminal (`dotnet run --project src/Ecommerce.Payments.Consumer` in
`../ecommerce-payments`).

**Payment succeeds** (total ≤ 10000):

```bash
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customerId":"<seeded customer id>","items":[{"productId":"p-1","quantity":1,"unitPrice":50}]}'
```

Within about 5s, `SELECT status FROM orders WHERE id = '<orderId>'` returns `CONFIRMED`, and exactly
one message for that `aggregateId` is on `orders.order-confirmed` (check with
`kafka-console-consumer`, or kafka-ui via `docker compose --profile tools up -d`).

**Payment fails** (total > 10000, e.g. `quantity: 3, unitPrice: 5000`): the status becomes
`CANCELLED`, `cancellationReason` contains the threshold message, and exactly one
`orders.order-cancelled` message carries the same `reason`.

## 3. Idempotency and failure handling (manual)

Produce messages straight to the topic with `kafka-console-producer` inside the infra Kafka
container (`--bootstrap-server kafka:29092`):

| Scenario | Message | Expected |
|---|---|---|
| Replay | Re-send the exact `payments.payment-processed` value from step 2 | No status change, no new `orders.order-confirmed`, `processed_events` row count unchanged. |
| Conflict | `payments.payment-failed` for the CONFIRMED order (new `eventId`) | Status stays `CONFIRMED`, warn log, `processed_events.outcome = IGNORED_CONFLICT`. |
| Malformed | `not json` | One `consumed_message_dead_letters` row with `failureType = MALFORMED`, `attempts = 1`, logged right away; the next message is still processed. |
| Unknown order | Valid payload with a random `orderId` | Warn logs for attempts 1–5 with increasing delays, then one row with `failureType = RETRIES_EXHAUSTED`, `attempts = 5`. |
| `aggregateId` ≠ order | Valid payload where `aggregateId` is an existing **order** id and `orderId` is random | The existing order is **not** touched; the message is dead-lettered as unknown order. |

## 4. HTTP stays up without Kafka

With the app running, stop the infra Kafka container. The consumer logs connection retries,
and `POST /orders/:id/cancel` still answers (FR-019). The outbound publish fails and goes to
`order_dead_letters`, as it does today. Note: a cold start with Kafka down still fails, because
the **existing** producer awaits `connect()` at bootstrap. That is unchanged by this feature and
noted as a follow-up in plan.md. Set `KAFKA_CONSUMER_ENABLED=false` to start without the
consumer at all.
