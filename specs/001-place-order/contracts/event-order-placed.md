# Contract: Kafka Event `orders.order-placed`

Published by `OrderEventsProducer` **only after** the order has been durably saved to PostgreSQL (Principle III). This service is the sole producer of this event.

## Payload

```json
{
  "eventId": "uuid",
  "occurredAt": "ISO 8601 timestamp",
  "aggregateId": "orderId (uuid)",
  "version": 1,
  "customerId": "uuid",
  "items": [
    { "productId": "string", "quantity": "integer", "unitPrice": "number" }
  ],
  "totalAmount": "number"
}
```

| Field | Type | Notes |
|---|---|---|
| `eventId` | UUID | Unique per publish attempt |
| `occurredAt` | ISO 8601 string | When the order was durably saved |
| `aggregateId` | UUID | The `Order.id` |
| `version` | integer | Schema version; `1` for this contract. A breaking payload change requires a new topic version (`orders.order-placed.v2`), not a change to this contract |
| `customerId` | UUID | |
| `items` | array | Post-consolidation line items (one entry per distinct `productId`) |
| `totalAmount` | number | |

## Failure handling

If publishing this event fails after the DB save succeeded:
- The failure is logged with full context (event payload + error).
- The event is stored in the `order_dead_letters` table (see data-model.md) for later retry.
- The client still receives `201 Created` — the DB save already succeeded, so the order is real; only the notification to other systems is delayed.

## Consumers

None in this repo — this service is a Kafka producer only for this event (Principle VII). A future, separate read-side service is expected to consume this topic to build its own query-optimized view and own database; whatever consumes it must be idempotent (e.g. upsert by `aggregateId`), since Kafka does not guarantee exactly-once delivery. Other bounded contexts (inventory, fulfillment) consuming this topic are outside this service's concern.
