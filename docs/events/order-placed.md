# Event: `OrderPlaced`

**Topic**: `orders.order-placed`

**Producer**: `ecommerce-orders` (Orders module, `OrderEventsProducer`) — this service is the sole
producer of this event.

**Emitted when**: An order has been successfully and durably saved to the write database
(PostgreSQL). Never emitted before the save succeeds (see Constitution Principle III / VII).

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

| Field | Type | Semantics |
|---|---|---|
| `eventId` | UUID | Unique per publish attempt; used as the dead-letter record key on failure. |
| `occurredAt` | ISO 8601 string | Timestamp the order was created (`Order.createdAt`). |
| `aggregateId` | UUID | The `Order.id` this event describes. |
| `version` | integer | Event schema version. Currently `1`. A breaking payload change requires a new topic version (`orders.order-placed.v2`), not a change to this payload. |
| `customerId` | UUID | The customer who placed the order. |
| `items` | array of `{ productId, quantity, unitPrice }` | Consolidated line items — one entry per distinct `productId`, with quantities already summed. |
| `totalAmount` | number | Sum of all item subtotals (`quantity × unitPrice`), rounded to 2 decimal places. |

## Failure handling

If publishing fails after the DB save has already succeeded, the failure is logged and the
full event payload is stored in the `order_dead_letters` table (see
`specs/001-place-order/data-model.md`) for later retry. The client still receives `201
Created`, since the order itself was saved successfully — only the notification to other
systems is delayed.

## Consumers

This service has no consumer of its own — it is a Kafka **producer only** (per Constitution
Principle VII). A denormalized, query-optimized read model of orders is intentionally deferred
to a separate future service, which will consume this topic and own its own database rather
than living in this repo. Other bounded contexts (inventory, fulfillment, etc.) may also consume
this topic; their contracts are out of scope for this service.
