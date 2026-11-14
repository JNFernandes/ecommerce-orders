# Event: `OrderCancelled`

**Topic**: `orders.order-cancelled`

**Producer**: `ecommerce-orders` (`OrderEventsProducer`) — this service is the sole producer of
this event.

**Emitted when**: A `PENDING` order has been successfully cancelled and the status change is
durably saved to the write database (PostgreSQL). A cancellation is triggered by
`POST /orders/:orderId/cancel`, or by the first negative outcome for a pending order: a consumed
`payments.payment-failed` ([payment-failed.md](payment-failed.md)) or `inventory.stock-rejected`
([stock-rejected.md](stock-rejected.md)) event, whatever the other outcome (US-09). Never
emitted before the save succeeds (see Constitution Principle III / VII), and never emitted at
all if the order wasn't `PENDING` (the REST endpoint returns `409 Conflict`; the consumers record
an ignored outcome).

## Payload

```json
{
  "eventId": "uuid",
  "occurredAt": "ISO 8601 timestamp",
  "aggregateId": "orderId (uuid)",
  "version": 1,
  "customerId": "uuid",
  "reason": "string (optional)"
}
```

| Field | Type | Semantics |
|---|---|---|
| `eventId` | UUID | Unique per event. A dead-letter retry republishes the **same** `eventId`, so consumers can deduplicate. |
| `occurredAt` | ISO 8601 string | Timestamp the order was cancelled (`Order.updatedAt` at the time of cancellation). |
| `aggregateId` | UUID | The `Order.id` this event describes. |
| `version` | integer | Event schema version. Currently `1`. A breaking payload change requires a new topic version (`orders.order-cancelled.v2`), not a change to this payload. |
| `customerId` | UUID | The customer whose order was cancelled. |
| `reason` | string, **optional** | Why the order was cancelled. Present only for outcome-driven cancellations: `payment failed: <reason>` or `stock rejected: <reason>` (just `payment failed` / `stock rejected` when the source reason is empty); **omitted** for REST cancellations. Added in US-04 as an additive, non-breaking field and given its prefixes in US-09, so `version` stays `1`. Consumers must treat a missing `reason` as "no reason given". |

Unlike `OrderPlaced`, this payload does not repeat the order's items or total — a consumer that
needs that detail should already have it from the earlier `OrderPlaced` event for the same
`aggregateId`.

## Failure handling

If publishing fails after the DB status update has already succeeded, the failure is logged and
the full event payload is stored in the `order_dead_letters` table and republished automatically by the dead-letter worker, with the same `eventId`, once Kafka accepts it (see [dead-letter-retry.md](../dead-letter-retry.md)). For a REST
cancellation the client still receives `200 OK`; for an outcome-driven one the payment or stock
message still counts as processed. In both cases the cancellation itself was durably saved, and only the
notification to other systems is delayed.

## Consumers

- **This service**: the read-model projection (`OrderProjectionConsumer`, consumer group
  `ecommerce-orders-projection`, US-05) keeps the MongoDB `order_views` read model up to date.
  See [read-model.md](../read-model.md).
- **Payments** refunds a processed payment and **Inventory** releases a reserved stock for the
  order; both ignore the event when there is nothing to undo (`ecommerce-infra/docs/events.md`).
- **Other services** (for example Notifications) may consume this topic. Their contracts are out
  of scope here.
