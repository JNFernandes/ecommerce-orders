# Event: `OrderConfirmed`

**Topic**: `orders.order-confirmed`

**Producer**: `ecommerce-orders` (`OrderEventsProducer`) — this service is the sole producer of
this event.

**Emitted when**: A `PENDING` order has been successfully confirmed and the status change is
durably saved to the write database (PostgreSQL). Never emitted before the save succeeds (see
Constitution Principle III / VII), and never emitted at all if the order wasn't `PENDING`
(confirmation is rejected with `409 Conflict` before any DB write is attempted).

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
| `eventId` | UUID | Unique per event. A dead-letter retry republishes the **same** `eventId`, so consumers can deduplicate. |
| `occurredAt` | ISO 8601 string | Timestamp the order was confirmed (`Order.updatedAt` at the time of confirmation). |
| `aggregateId` | UUID | The `Order.id` this event describes. |
| `version` | integer | Event schema version. Currently `1`. A breaking payload change requires a new topic version (`orders.order-confirmed.v2`), not a change to this payload. |
| `customerId` | UUID | The customer whose order was confirmed. |

Same minimal shape as `OrderCancelled` — a consumer needing item/total detail should already
have it from the earlier `OrderPlaced` event for the same `aggregateId`.

## Failure handling

If publishing fails after the DB status update has already succeeded, the failure is logged and
the full event payload is stored in the `order_dead_letters` table and republished automatically by the dead-letter worker, with the same `eventId`, once Kafka accepts it (see [dead-letter-retry.md](../dead-letter-retry.md)). The client
still receives `200 OK`, since the confirmation itself was durably saved — only the notification
to other systems is delayed.

## Consumers

- **This service**: the read-model projection (`OrderProjectionConsumer`, consumer group
  `ecommerce-orders-projection`, US-05) keeps the MongoDB `order_views` read model up to date.
  See [read-model.md](../read-model.md).
- **Other services** (for example Notifications) may consume this topic. Their contracts are out
  of scope here.

Since US-04, this event is also emitted when a `payments.payment-processed` event confirms the
order (see [payment-processed.md](payment-processed.md)), with the same payload.
