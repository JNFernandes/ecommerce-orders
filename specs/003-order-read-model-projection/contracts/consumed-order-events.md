# Contract: order events consumed by the projection

**Topics**: `orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled`
**Producer**: `ecommerce-orders` itself (`OrderEventsProducer`). The payload shapes are
documented in `docs/events/order-placed.md`, `order-confirmed.md` and `order-cancelled.md`, and
are **unchanged** by this story.
**Consumer group**: `KAFKA_PROJECTION_GROUP_ID` (default `ecommerce-orders-projection`), starting
from the earliest offset.
**Message key**: `aggregateId` (the order id).

## Fields the projection requires (anything else is ignored)

| Field | Placed | Confirmed | Cancelled | Rule (violations are malformed and dead-lettered without retry) |
|---|---|---|---|---|
| `eventId` | ✓ | ✓ | ✓ | UUID |
| `occurredAt` | ✓ | ✓ | ✓ | ISO 8601 timestamp |
| `aggregateId` | ✓ | ✓ | ✓ | UUID (the order id) |
| `version` | ✓ | ✓ | ✓ | must equal `1` |
| `customerId` | ✓ | ✓ | ✓ | UUID |
| `items[]` | ✓ | | | non-empty array; `productId` non-empty string, `quantity` integer ≥ 1, `unitPrice` number ≥ 0 |
| `totalAmount` | ✓ | | | number ≥ 0 |
| `reason` | | | optional | string if present; absent or `null` means no reason |

These DTO classes (`src/read-model/messages/*`) are separate from the write-side domain event
classes, even though the JSON is the same (FR-019).

## Outcomes per message

| Situation | Effect | Offset |
|---|---|---|
| Valid and new to its view | View created or updated per the rules in [data-model.md](../data-model.md) | committed after the Mongo write |
| `eventId` already in `appliedEventIds` | none | committed |
| Malformed | dead letter `MALFORMED`, attempts 1 | committed after the dead-letter write |
| Write conflict or unexpected error, persisting through every retry | dead letter `RETRIES_EXHAUSTED` | committed after the dead-letter write |
| MongoDB unreachable after every retry | none, the consumer restarts | **not** committed (redelivered) |
