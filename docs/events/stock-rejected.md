# Event: `StockRejected` (consumed)

**Topic**: `inventory.stock-rejected`

**Producer**: `ecommerce-inventory`. Platform contract: `ecommerce-infra/docs/events.md`
(Inventory events). This page must stay consistent with it.

**Consumer in this service**: `InventoryEventsConsumer` (`src/infra/kafka/inventory-events.consumer.ts`),
consumer group `KAFKA_INVENTORY_GROUP_ID` (default `ecommerce-orders-inventory-consumer`).
Introduced by US-09.

**Meaning**: at least one item of the order could not be reserved, and nothing was reserved.
Orders cancels the order at once, whatever the payment outcome
([ADR 0006](../adr/0006-order-joins-payment-and-stock-outcomes.md)).

## Payload

```json
{
  "eventId": "1c7e5a43-6b1d-4c8e-8a2e-3e9b7d4f5a21",
  "aggregateId": "5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33",
  "occurredAt": "2026-11-14T10:00:01.000Z",
  "version": 1,
  "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e",
  "reason": "insufficient stock",
  "items": [{ "productId": "sku-1", "requested": 5, "available": 2 }],
  "rejectedAt": "2026-11-14T10:00:01.000Z"
}
```

| Field | Type | Required here | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key, stored in `processed_events`. |
| `aggregateId` | UUID | yes | **The reservation id.** Logged and stored as `reservationId`. **Never used as an order id.** |
| `occurredAt` | ISO 8601 | yes | Validated, otherwise not used. |
| `version` | integer | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order to cancel.** |
| `reason` | string | no | One of `insufficient stock`, `unknown product`, `unknown product and insufficient stock`. Orders does not restrict the value. Stored as `cancellationReason = "stock rejected: <reason>"` (just `stock rejected` when missing, `null` or empty). Any non-string value means the message is malformed. |
| `items` | array | no | Only the failed items, sorted by `productId`: `{ productId, requested, available }` (`available` is `0` for an unknown product). Not used. |
| `rejectedAt` | timestamp | no | Not used. |

Unknown extra fields are ignored.

## What Orders does

| Order (looked up by `orderId`) | Effect | Event published | `processed_events.outcome` |
|---|---|---|---|
| `PENDING`, stock pending (any payment outcome) | stock outcome → `REJECTED`, order → `CANCELLED` with `stock rejected: <reason>` | exactly one `OrderCancelled`, with that `reason` | `CANCELLED` |
| `PENDING`, stock already reserved | nothing; **warning** (the first stock outcome wins) | none | `IGNORED_CONFLICT` |
| `CONFIRMED` | nothing; **warning** (conflict) | none | `IGNORED_CONFLICT` |
| `CANCELLED` | nothing, informational log | none | `IGNORED_ALREADY_CANCELLED` |
| no such order | retried with backoff, then dead-lettered and retried later by the dead-letter worker | none | — |

When the payment was already processed, Payments refunds it on reading `OrderCancelled`.

## Delivery guarantees

Identical to [stock-reserved.md](stock-reserved.md#delivery-guarantees).
