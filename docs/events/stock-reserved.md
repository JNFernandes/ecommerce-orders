# Event: `StockReserved` (consumed)

**Topic**: `inventory.stock-reserved`

**Producer**: `ecommerce-inventory`. Platform contract: `ecommerce-infra/docs/events.md`
(Inventory events). This page must stay consistent with it.

**Consumer in this service**: `InventoryEventsConsumer` (`src/infra/kafka/inventory-events.consumer.ts`),
consumer group `KAFKA_INVENTORY_GROUP_ID` (default `ecommerce-orders-inventory-consumer`).
Introduced by US-09.

**Meaning**: every item of the order was reserved atomically. Orders records the stock outcome
and confirms the order once the payment has also been processed
([ADR 0006](../adr/0006-order-joins-payment-and-stock-outcomes.md)).

## Payload

```json
{
  "eventId": "9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11",
  "aggregateId": "5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33",
  "occurredAt": "2026-11-14T10:00:01.000Z",
  "version": 1,
  "orderId": "4889fbea-c49f-4094-8ca9-45d79508477e",
  "items": [{ "productId": "sku-1", "quantity": 2 }],
  "reservedAt": "2026-11-14T10:00:01.000Z"
}
```

| Field | Type | Required here | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key, stored in `processed_events`. |
| `aggregateId` | UUID | yes | **The reservation id.** Logged and stored as `reservationId`. **Never used as an order id.** Also the Kafka message key. |
| `occurredAt` | ISO 8601 | yes | Validated, otherwise not used. |
| `version` | integer | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order whose stock was reserved.** |
| `items` | array | no | `{ productId, quantity }`, one per product, sorted by `productId`; consolidated quantities, which can exceed 32 bits. Not used. |
| `reservedAt` | timestamp | no | Not used. |

Unknown extra fields are ignored.

## What Orders does

| Order (looked up by `orderId`) | Effect | Event published | `processed_events.outcome` |
|---|---|---|---|
| `PENDING`, payment pending | stock outcome → `RESERVED`, order stays `PENDING` | none | `RECORDED` |
| `PENDING`, payment processed | stock outcome → `RESERVED`, order → `CONFIRMED` | exactly one `OrderConfirmed` | `CONFIRMED` |
| `PENDING`, stock already reserved | nothing | none | `IGNORED_DUPLICATE` |
| `CONFIRMED` | nothing, informational log | none | `IGNORED_ALREADY_CONFIRMED` |
| `CANCELLED` | nothing, informational log (Inventory releases the stock when it reads `OrderCancelled`) | none | `IGNORED_ALREADY_CANCELLED` |
| no such order | retried with backoff, then dead-lettered (`RETRIES_EXHAUSTED`) and retried later by the dead-letter worker | none | — |

The rules live in the `Order` aggregate (`recordStockReserved()`); the consumer only parses,
dispatches `ApplyStockOutcomeCommand` and commits.

## Delivery guarantees

Identical to the payment consumers ([payment-processed.md](payment-processed.md#delivery-guarantees)):

- **Idempotent**: dedupe by `eventId`; the order change and the `processed_events` row are saved in
  one transaction, guarded on the order still being `PENDING` with the outcomes it was loaded
  with, so a payment and a stock outcome processed at the same time cannot both miss the
  confirmation.
- **Offsets** are committed only after the outcome has been saved (state change, ignored-outcome
  record or dead-letter row).
- **Malformed** messages (not JSON; `eventId`, `orderId` or `aggregateId` missing or not a UUID;
  `occurredAt` not ISO 8601; `version` ≠ 1) are dead-lettered immediately as `EXHAUSTED`, with no
  retry.
- **Other failures**, including a database outage, are retried with exponential backoff
  (`PAYMENT_CONSUMER_*` settings), then dead-lettered as `PENDING_RETRY` and replayed by the
  dead-letter worker ([dead-letter-retry.md](../dead-letter-retry.md)).
- If publishing `OrderConfirmed` fails after the save, the event goes to `order_dead_letters`
  and the stock message still counts as processed.
