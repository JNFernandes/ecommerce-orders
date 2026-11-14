# Consumed event: `inventory.stock-reserved`

Published by `ecommerce-inventory`. Authoritative contract: `ecommerce-infra/docs/events.md`
(Inventory events). This file states what Orders relies on; `docs/events/stock-reserved.md` is
written from it.

## Payload (version 1)

| Field | Type | Used by Orders | Notes |
|---|---|---|---|
| `eventId` | UUID | yes, required | Dedupe key (`processed_events`). |
| `aggregateId` | UUID | audit only, required | **Reservation id.** Stored as `reservationId`; never an order id. Also the Kafka key. |
| `occurredAt` | ISO 8601 | validated, required | |
| `version` | integer | validated, must be `1` | Any other value is malformed. |
| `orderId` | UUID | yes, required | Identifies the order. |
| `items` | array | no | `{ productId, quantity }`, sorted by `productId`. Not validated. |
| `reservedAt` | timestamp | no | Not validated. |

## Orders behaviour

- `PENDING` order, payment pending → stock outcome `RESERVED`, order stays `PENDING`, nothing
  published.
- `PENDING` order, payment processed → order `CONFIRMED`, `OrderConfirmed` published after the
  save.
- Stock already reserved on a `PENDING` order → ignored (duplicate outcome).
- `CONFIRMED` or `CANCELLED` order → ignored, informational log.
- Malformed → dead-lettered at once (`EXHAUSTED`). Unknown `orderId` → retried, then
  dead-lettered (`PENDING_RETRY`).

## Example

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
