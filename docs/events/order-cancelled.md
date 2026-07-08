# Event: `OrderCancelled`

**Topic**: `orders.order-cancelled`

**Producer**: `ecommerce-orders` (`OrderEventsProducer`) — this service is the sole producer of
this event.

**Emitted when**: A `PENDING` order has been successfully cancelled and the status change is
durably saved to the write database (PostgreSQL). Never emitted before the save succeeds (see
Constitution Principle III / VII), and never emitted at all if the order wasn't `PENDING`
(cancellation is rejected with `409 Conflict` before any DB write is attempted).

## Payload

```json
{
  "eventId": "uuid",
  "occurredAt": "ISO 8601 timestamp",
  "aggregateId": "orderId (uuid)",
  "version": 1,
  "customerId": "uuid"
}
```

| Field | Type | Semantics |
|---|---|---|
| `eventId` | UUID | Unique per publish attempt; used as the dead-letter record key on failure. |
| `occurredAt` | ISO 8601 string | Timestamp the order was cancelled (`Order.updatedAt` at the time of cancellation). |
| `aggregateId` | UUID | The `Order.id` this event describes. |
| `version` | integer | Event schema version. Currently `1`. A breaking payload change requires a new topic version (`orders.order-cancelled.v2`), not a change to this payload. |
| `customerId` | UUID | The customer whose order was cancelled. |

Unlike `OrderPlaced`, this payload does not repeat the order's items or total — a consumer that
needs that detail should already have it from the earlier `OrderPlaced` event for the same
`aggregateId`.

## Failure handling

If publishing fails after the DB status update has already succeeded, the failure is logged and
the full event payload is stored in the `order_dead_letters` table for later retry. The client
still receives `200 OK`, since the cancellation itself was durably saved — only the notification
to other systems is delayed.

## Consumers

This service has no consumer of its own — it is a Kafka **producer only** (per Constitution
Principle VII), same as `OrderPlaced`. A denormalized, query-optimized read model of orders is
intentionally deferred to a separate future service, which will consume both `orders.order-placed`
and `orders.order-cancelled` and own its own database rather than living in this repo. Other
bounded contexts (inventory, fulfillment, etc.) may also consume this topic; their contracts are
out of scope for this service.
