# Quickstart: validate the Order Read Model Projection (US-05)

A run-and-check guide. The document shape is in
[contracts/order-view-document.md](contracts/order-view-document.md) and the rules in
[data-model.md](data-model.md).

## Prerequisites

- `../ecommerce-infra`: `docker compose up -d` (Kafka `:9092`, Postgres `:5432`, MongoDB `:27017`
  with `mongo_user` / `mongo_pass`).
- `ecommerce-orders`: `npm ci`, and add the two new variables to `.env` from `.env.example`
  (`MONGO_URI`, `KAFKA_PROJECTION_GROUP_ID`).
- Optional: `../ecommerce-payments` running, for automatic confirm and cancel.

## 1. Automated checks

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit          # projector rules (out-of-order, duplicates, conflicts), service, parser, helper
npm run test:integration   # OrderViewRepository and the projection against a real MongoDB container
npm run test:component     # Kafka + Postgres + Mongo: placed → PENDING view → confirmed → CONFIRMED view
```

The US-04 suites must still pass unchanged, since the consumer helper is shared.

## 2. Live: backfill and new orders

```bash
npm run start:dev
# the log shows the "order projection consumer running (group ecommerce-orders-projection …)" line
```

Backfill: every order still in Kafka's 7-day window gets a view.

```bash
docker exec ecommerce-mongo-1 mongosh -u mongo_user -p mongo_pass --authenticationDatabase admin --quiet \
  orders_read --eval 'db.order_views.countDocuments()'
docker exec ecommerce-postgres-orders-1 psql -U orders_user -d orders -tAc 'select count(*) from orders'
```

The two counts should be equal (for orders inside the retention window).

New order: `POST /orders` (see the README). Within about 5s `db.order_views.findOne({_id: "<orderId>"})`
shows `status: "PENDING"` with items and total. After the payment outcome it shows `CONFIRMED`
(or `CANCELLED` with `cancellationReason`).

Status, items and total should match Postgres for every order (SC-003):

```bash
docker exec ecommerce-mongo-1 mongosh -u mongo_user -p mongo_pass --authenticationDatabase admin --quiet \
  orders_read --eval 'db.order_views.find({}, {status:1, totalAmount:1}).toArray()'
```

## 3. Rebuild and replay produce identical documents (FR-015)

```bash
# snapshot
docker exec ecommerce-mongo-1 mongosh … orders_read --eval 'JSON.stringify(db.order_views.find().sort({_id:1}).toArray())' > before.json
# stop the app, then reset the projection group to the beginning
docker exec ecommerce-kafka-1 kafka-consumer-groups --bootstrap-server localhost:29092 \
  --group ecommerce-orders-projection --reset-offsets --to-earliest --all-topics --execute
# (a) replay over the existing documents → every event is a duplicate, nothing changes
# (b) or drop first for a full rebuild:  db.order_views.drop()
npm run start:dev   # wait until the projection group's lag is 0
docker exec ecommerce-mongo-1 mongosh … orders_read --eval 'JSON.stringify(db.order_views.find().sort({_id:1}).toArray())' > after.json
diff before.json after.json   # expected: no differences
```

## 4. Failure handling

| Scenario | How | Expected |
|---|---|---|
| Malformed event | `echo 'not json' \| docker exec -i ecommerce-kafka-1 kafka-console-producer --bootstrap-server localhost:29092 --topic orders.order-placed` | One `consumed_message_dead_letters` row (`MALFORMED`, topic `orders.order-placed`); the next orders are still projected. The payment consumer is unaffected. |
| MongoDB outage | `docker stop ecommerce-mongo-1`, place an order, then `docker start ecommerce-mongo-1` | HTTP and payment confirm/cancel keep working. The projection logs retries, does **not** dead-letter, and the view appears after Mongo is back. |
| Out of order | Covered by unit and integration tests (it is hard to force with live topics) | — |
