# Order read model

The query side of CQRS in `ecommerce-orders` ([ADR 0001](adr/0001-cqrs-read-model-in-orders-service.md)).
Every order has a **view** in MongoDB, kept up to date by a projection that consumes the
service's own order events. It is read by the GraphQL `orders` (US-06) and `order` (US-07) queries (see the
[README](../README.md#graphql-read-path)). The consistency approach is recorded in [ADR 0004](adr/0004-read-model-projection-consistency.md).

```text
POST /orders ─▶ PostgreSQL (write model) ─▶ Kafka orders.* ─▶ OrderProjectionConsumer
                                                              └─▶ OrderProjectionService
                                                                   └─▶ projectOrderEvent (rules)
                                                                        └─▶ MongoDB order_views
```

The read model is **eventually consistent**: a view usually reflects a change within about a
second, but a query issued right after a write may not see it yet.

## Where the code lives

| Path | Role |
|---|---|
| `src/infra/kafka/order-projection.consumer.ts` | Inbound adapter: consumer group `KAFKA_PROJECTION_GROUP_ID`, the three `orders.*` topics from the earliest offset, manual offset commit |
| `src/infra/kafka/order-event-message.parser.ts` | Raw message → validated `OrderEvent` (read-side DTOs in `src/read-model/messages/`) |
| `src/read-model/order-projection.service.ts` | Load the view → apply the rules → save |
| `src/read-model/order-view.projector.ts` | The projection rules: a pure function |
| `src/read-model/order-view.repository.ts` | MongoDB persistence with optimistic concurrency |
| `src/read-model/read-model.module.ts` | `MongooseModule` (lazy connection) + the above |

Nothing under `src/read-model/` imports the write side (`src/domain`, TypeORM entities, write
services or repositories). The read model has its own `OrderViewStatus` enum, and a unit test
checks that its values match the write model's `OrderStatus`.

## Indexes

| Name | Keys | Serves |
|---|---|---|
| `customerId_placedAt` | `{ customerId: 1, placedAt: -1, _id: -1 }` | `orders(customerId: …)` |
| `status_placedAt` | `{ status: 1, placedAt: -1, _id: -1 }` | `orders(status: …)` |
| `placedAt` | `{ placedAt: -1, _id: -1 }` | `orders` without filters |

Declared on the schema and created by `OrderViewRepository.ensureIndexes()` every time the
connection is established (`autoIndex` is off so index builds never race the lazy connection).
The list query sorts by `placedAt` desc then `_id` desc, so views without `placedAt` come last.

## Document shape: `order_views`

One document per order, with `_id` = the order id. Every field is always present; a value not
known yet is `null`. The full contract, with examples, is in
[`specs/003-order-read-model-projection/contracts/order-view-document.md`](../specs/003-order-read-model-projection/contracts/order-view-document.md).

| Field | Type | Meaning |
|---|---|---|
| `_id`, `orderId` | UUID string | The order |
| `customerId` | UUID string | Owner of the order |
| `status` | `PENDING` / `CONFIRMED` / `CANCELLED` | Never goes back to `PENDING` |
| `items` | `[{ productId, quantity, unitPrice, subtotal }]` or `null` | `subtotal = round2(quantity × unitPrice)` |
| `totalAmount` | number or `null` | |
| `placedAt` | Date or `null` | `OrderPlaced.occurredAt` |
| `confirmedAt` | Date or `null` | Set only when `CONFIRMED` |
| `cancelledAt` | Date or `null` | Set only when `CANCELLED` |
| `cancellationReason` | string or `null` | Only for cancellations that carried a reason (payment failures); may be `""` |
| `updatedAt` | Date | Latest `occurredAt` of the applied events (**not** the projection time) |
| `appliedEventIds` | string[] | Sorted ids of the applied events (internal; dedupe) |
| `statusEventId` | string or `null` | The terminal event that decided `status` (internal) |
| `revision` | number | Optimistic-concurrency counter, equal to the number of applied events (internal) |

`items`, `totalAmount` and `placedAt` are either all `null` or all set. A view can exist without
them when the confirmation or cancellation was projected before `OrderPlaced`.

## Projection rules

| Event | Effect |
|---|---|
| `OrderPlaced` | Fills customer, items, total and `placedAt`. A new view starts as `PENDING`; an existing `CONFIRMED`/`CANCELLED` view **keeps** its status. |
| `OrderConfirmed` | Status `CONFIRMED`, `confirmedAt`. Creates the view if it arrives first. |
| `OrderCancelled` | Status `CANCELLED`, `cancelledAt`, `cancellationReason` (if any). Creates the view if it arrives first. |

The rules are designed so that **any arrival order** and **any replay** produce the same view:

- **Out of order**: the three topics are independent, so a terminal event can be projected before
  `OrderPlaced`. The late `OrderPlaced` completes the view and never resets the status.
- **Duplicates**: an event whose `eventId` is already in `appliedEventIds` changes nothing, and
  nothing is written.
- **Conflicting terminals** (both confirmed and cancelled; the write side never produces this):
  the one that **occurred first** wins (earlier `occurredAt`, then the smaller `eventId`). The
  other is recorded as applied, and a warning is logged.
- **Determinism**: `updatedAt` comes from event times, `appliedEventIds` is sorted, and `revision`
  counts applied events. The order in which events arrive or are replayed never shows in the
  document.

Each write replaces the whole document only if `revision` is still the one that was read
(`insert` for a new view, conditional `replaceOne` otherwise). A concurrent writer, such as a
second instance, causes a retry instead of a lost update.

## Failure handling

The projection uses the same consumer flow as the payment consumer (`consumeWithDeadLetter`):

| Situation | Result | Offset |
|---|---|---|
| Malformed event (not JSON, bad ids, `version` ≠ 1, invalid items, …) | `consumed_message_dead_letters` row, `MALFORMED`, no retry | committed |
| Write conflict, or an unexpected error | retried with exponential backoff, then dead-lettered (`RETRIES_EXHAUSTED`) | committed after the dead-letter write |
| **MongoDB unreachable** | retried, then **not** dead-lettered: the error is rethrown, kafkajs restarts the consumer, and the event is redelivered | **not** committed |

**How an outage is detected**: known driver connectivity errors (server selection, network,
not-connected) count as an outage directly. For **any other** error, the repository pings MongoDB
(2s timeout) and treats the error as an outage if the ping fails. This matters because, during an
outage, the driver does not always report a network error. With Docker on Windows, a stopped
container's port can still accept the connection, so the handshake fails with
`Authentication failed.`. That was found during live validation, where it dead-lettered a healthy
event before the ping check was added.

A MongoDB outage never affects the HTTP API or the payment consumer. The connection is lazy,
and `ReadModelConnectionMonitor` keeps retrying the initial connection every 5s until it
succeeds.

## Backfill and rebuild

- **First start**: the projection group starts at the earliest offset, so every order whose
  events are still in Kafka gets a view.
- **Rebuild** (after a document-shape change, or to repair the model):

  ```bash
  # stop the app, then:
  docker exec ecommerce-mongo-1 mongosh -u mongo_user -p mongo_pass --authenticationDatabase admin \
    orders_read --eval 'db.order_views.drop()'          # optional: full rebuild
  docker exec ecommerce-kafka-1 kafka-consumer-groups --bootstrap-server localhost:29092 \
    --group ecommerce-orders-projection --reset-offsets --to-earliest --all-topics --execute
  # start the app; wait until the group's lag is 0
  ```

  Replaying over existing documents changes nothing. Replaying into an empty collection produces
  identical documents.

### Limits

- **Kafka retention**: the order topics keep events for **7 days** (`retention.ms = 604800000`,
  delete policy, in `ecommerce-infra`). Orders whose events are older cannot be backfilled or
  rebuilt by replay. A rebuild-from-PostgreSQL job, or longer or compacted retention, is a
  possible follow-up.
- **Unpublished events**: an `OrderPlaced` that failed to publish (in `order_dead_letters`)
  appears in the read model only once it is republished (US-08).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/orders_read` | Read-model database. Locally: `mongodb://mongo_user:mongo_pass@localhost:27017/orders_read?authSource=admin` |
| `KAFKA_PROJECTION_GROUP_ID` | `ecommerce-orders-projection` | Projection consumer group (separate from `KAFKA_GROUP_ID`) |
| `KAFKA_CONSUMER_ENABLED` | `true` | Starts both consumers (payment and projection) |
| `PAYMENT_CONSUMER_MAX_ATTEMPTS` / `_BACKOFF_INITIAL_MS` / `_BACKOFF_MAX_MS` | 5 / 1000 / 30000 | Retry settings for **both** consumers (names kept for compatibility) |
