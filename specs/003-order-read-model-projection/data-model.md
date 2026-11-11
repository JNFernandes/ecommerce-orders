# Data Model: Order Read Model Projection (US-05)

Phase 1 output for [plan.md](plan.md). Everything here lives on the **read side**
(`src/read-model/`). Nothing is imported from `src/domain/` or `src/infra/database/entities/`,
except the `OrderStatus` enum values (FR-004 says to use the same values).

> **`OrderStatus` reuse**: the spec requires the *values* `PENDING | CONFIRMED | CANCELLED`. To keep
> the paths fully separate (FR-019), the read side declares its own `OrderViewStatus` enum with the
> same string values, plus a unit test asserting they match `OrderStatus`. No import crosses the
> boundary.

## MongoDB: database from `MONGO_URI`, collection `order_views`

One document per order. `_id` is the order id (a UUID string). All fields are always present, and
unknown values are `null`.

| Field | Type | Null | Set by | Notes |
|---|---|---|---|---|
| `_id` | string (UUID) | no | first event | Equals `orderId`. |
| `orderId` | string (UUID) | no | first event | The event's `aggregateId`. |
| `customerId` | string (UUID) | no | first event | All three events carry it. |
| `status` | `PENDING` / `CONFIRMED` / `CANCELLED` | no | rules below | |
| `items` | `OrderItemView[]` | yes | OrderPlaced | `null` until OrderPlaced arrives. |
| `totalAmount` | number | yes | OrderPlaced | |
| `placedAt` | Date | yes | OrderPlaced | The event's `occurredAt`. |
| `confirmedAt` | Date | yes | OrderConfirmed (if it wins) | |
| `cancelledAt` | Date | yes | OrderCancelled (if it wins) | |
| `cancellationReason` | string | yes | OrderCancelled (if it wins and carries `reason`) | `""` is kept as `""`; a missing reason gives `null`. |
| `updatedAt` | Date | no | every applied event | max(`occurredAt`) of the applied events. Never wall-clock. |
| `appliedEventIds` | string[] | no | every applied event | Sorted ascending; dedupe set. |
| `statusEventId` | string | yes | terminal events | Id of the terminal event that decided `status`; `null` while PENDING. |
| `revision` | number | no | every write | Optimistic concurrency; equals `appliedEventIds.length`. |

### `OrderItemView` (embedded, no `_id`)

| Field | Type | Notes |
|---|---|---|
| `productId` | string | |
| `quantity` | integer ≥ 1 | |
| `unitPrice` | number ≥ 0 | |
| `subtotal` | number | `round2(quantity × unitPrice)`, computed by the projector |

Indexes: only `_id`. Query indexes come with the GraphQL stories (US-06/07).

Mongoose schema: `src/read-model/order-view.schema.ts`, `@Schema({ collection: 'order_views',
versionKey: false, timestamps: false })`, with `_id: String`. Mongoose's automatic `__v` and
timestamps are disabled, because both would break determinism.

## Read-side types (`src/read-model/`)

| Type | Kind | Purpose |
|---|---|---|
| `OrderViewStatus` | enum | `PENDING`, `CONFIRMED`, `CANCELLED` |
| `OrderView` | interface | Plain object mirroring the document (without `_id` or `revision`). The projector's input and output. |
| `StoredOrderView` | interface | `{ view: OrderView; revision: number }`, returned by the repository. |
| `OrderEvent` | discriminated union | `OrderPlacedEvent` / `OrderConfirmedEvent` / `OrderCancelledEvent`, as produced by the parser. |
| `ProjectionResult` | union | `{ kind: 'unchanged' }` or `{ kind: 'changed'; view: OrderView; warnings: string[] }` |
| `OrderViewConcurrencyError` | error | Retryable: insert race or stale revision. |
| `ReadModelUnavailableError` | error | Fatal for the message: MongoDB unreachable. Redelivered, never dead-lettered. |

### `OrderEvent`

| Variant | Fields |
|---|---|
| `{ type: 'OrderPlaced' }` | `eventId`, `orderId`, `occurredAt: Date`, `customerId`, `items: {productId, quantity, unitPrice}[]`, `totalAmount` |
| `{ type: 'OrderConfirmed' }` | `eventId`, `orderId`, `occurredAt: Date`, `customerId` |
| `{ type: 'OrderCancelled' }` | `eventId`, `orderId`, `occurredAt: Date`, `customerId`, `reason: string \| null` |

## Projection rules: `projectOrderEvent(current, event)`

```text
if current && current.appliedEventIds includes event.eventId → unchanged

base = current ?? { orderId, customerId, status: PENDING, all optional fields null,
                    appliedEventIds: [], statusEventId: null, updatedAt: event.occurredAt }

OrderPlaced:
  fill customerId, items (with subtotal), totalAmount, placedAt = occurredAt
  status unchanged when it is already CONFIRMED/CANCELLED (never back to PENDING)

OrderConfirmed / OrderCancelled  (terminal):
  if status == PENDING (statusEventId == null)       → this event wins
  else if (occurredAt, eventId) < (winner's occurredAt, statusEventId) → this event wins,
        the previous winner's timestamp and reason are cleared, and a conflict warning is added
  else                                               → the event is only recorded, plus a warning
                                                       if it is the opposite terminal
  winner = Confirmed → status CONFIRMED, confirmedAt = occurredAt,
                       cancelledAt = null, cancellationReason = null
  winner = Cancelled → status CANCELLED, cancelledAt = occurredAt,
                       cancellationReason = reason ?? null, confirmedAt = null

always: appliedEventIds = sorted(appliedEventIds ∪ {eventId}),
        updatedAt = max(updatedAt, occurredAt)
```

Comparing against the winner requires its `occurredAt`, which is the winner's `confirmedAt` or
`cancelledAt`. Both are stored, so no extra field is needed.

**Properties** (all unit-tested):
- **Order independence**: for any permutation of an order's events, the final view is equal.
- **Idempotence**: applying any applied event again gives `unchanged`.
- **Monotonic status**: a terminal status never becomes PENDING.

## Configuration (`src/config/configuration.ts`)

| Env var | Default | Meaning |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/orders_read` | Read-model database. `.env.example` uses `mongodb://mongo_user:mongo_pass@localhost:27017/orders_read?authSource=admin`. |
| `KAFKA_PROJECTION_GROUP_ID` | `ecommerce-orders-projection` | Consumer group of the projection (separate from `KAFKA_GROUP_ID`). |
| `KAFKA_CONSUMER_ENABLED` | `true` | Existing; now gates both consumers. |
| `PAYMENT_CONSUMER_MAX_ATTEMPTS` / `_BACKOFF_INITIAL_MS` / `_BACKOFF_MAX_MS` | 5 / 1000 / 30000 | Existing; now also used by the projection consumer (documented; names kept for compatibility). |

New config section: `readModel: { mongoUri: string }`. `KafkaConfig` gains `projectionGroupId`.

## PostgreSQL

No schema change. The projection writes only to the existing `consumed_message_dead_letters`
table (US-04), through `ConsumedMessageDeadLetterRepository`.
