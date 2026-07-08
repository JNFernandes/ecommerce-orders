# Data Model: Place an Order

## Order (Aggregate Root — write model)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Generated on creation |
| `customerId` | UUID | Verified to exist (see Customer below) before the order is created; not a DB foreign key across bounded contexts |
| `status` | `OrderStatus` enum | `PENDING` on creation (this feature only ever writes `PENDING`) |
| `totalAmount` | decimal(12,2) | Sum of all `OrderItem.subtotal` after consolidation |
| `createdAt` | timestamp | Set on creation |
| `updatedAt` | timestamp | Set on creation (equal to `createdAt` for this feature) |

**Relationships**: One `Order` has many `OrderItem` (one-to-many, owned by the aggregate).

**Validation rules** (enforced in `Order.place()`, domain layer, no I/O):
- `items` must be non-empty after consolidation.
- Each item's `quantity` must be a positive integer.
- Each item's `unitPrice` must be a positive number.
- Items sharing the same `productId` are consolidated into one `OrderItem` (summed quantity) before validation/totaling.

**State transitions**: `PENDING` is the only status this feature produces. `PENDING → CONFIRMED` and `PENDING → CANCELLED` belong to future user stories (US-02, US-03) and are out of scope here.

## OrderItem (Value Object, persisted as a child row)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Persistence-only identity; not part of the domain value object's equality |
| `orderId` | UUID (FK → Order) | |
| `productId` | string | Non-empty |
| `quantity` | integer | > 0, post-consolidation |
| `unitPrice` | decimal(10,2) | > 0 |
| `subtotal` | decimal(12,2) | Computed: `quantity × unitPrice` |

**Constraint**: unique on (`orderId`, `productId`) — enforces that consolidation happened; two rows for the same product in the same order should never exist.

## Customer (read-only reference)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Looked up by `CustomerRepository.existsById()` |

Minimal by design — this feature only needs to know a customer exists, not its other attributes (see research.md Decision 1 for how this table is populated).

## OrderDeadLetter (`order_dead_letters` — failure capture)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `eventId` | UUID | The `eventId` of the `OrderPlaced` event that failed to publish |
| `topic` | string | e.g. `orders.order-placed` |
| `payload` | JSONB | Full event payload, so it can be replayed later |
| `error` | text | Captured error message/stack for diagnosis |
| `retryCount` | integer | Default `0`; incremented by a future retry job (out of scope here) |
| `createdAt` | timestamp | |

## OrderPlaced (domain event → Kafka payload)

Matches AC-04 in `docs/us-01-place-order.md` exactly:

| Field | Type |
|---|---|
| `eventId` | UUID |
| `occurredAt` | ISO 8601 timestamp |
| `aggregateId` | UUID (`Order.id`) |
| `version` | integer (`1`) |
| `customerId` | UUID |
| `items` | array of `{ productId: string, quantity: integer, unitPrice: number }` |
| `totalAmount` | number |

Published to Kafka topic `orders.order-placed` only after `Order` is durably saved (Principle III).

This service is a Kafka producer only for this event — there is no consumer or read-model table
in this repo (see research.md Decision 2, revised). A denormalized read view is deferred to a
separate future service that owns its own database.
