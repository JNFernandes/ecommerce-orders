# Consumed event: `inventory.stock-rejected`

Published by `ecommerce-inventory`. Authoritative contract: `ecommerce-infra/docs/events.md`
(Inventory events). `docs/events/stock-rejected.md` is written from this file.

## Payload (version 1)

| Field | Type | Used by Orders | Notes |
|---|---|---|---|
| `eventId` | UUID | yes, required | Dedupe key. |
| `aggregateId` | UUID | audit only, required | **Reservation id.** Never an order id. |
| `occurredAt` | ISO 8601 | validated, required | |
| `version` | integer | validated, must be `1` | |
| `orderId` | UUID | yes, required | Identifies the order. |
| `reason` | string | yes, optional for Orders | One of `insufficient stock`, `unknown product`, `unknown product and insufficient stock`. Orders does not restrict the value; missing or empty is accepted. |
| `items` | array | no | `{ productId, requested, available }` for the failed items. Not validated. |
| `rejectedAt` | timestamp | no | Not validated. |

## Orders behaviour

- `PENDING` order (any payment outcome) → stock outcome `REJECTED`, order `CANCELLED` with
  reason `stock rejected: <reason>` (`stock rejected` when empty), `OrderCancelled` published
  with that reason after the save.
- `CONFIRMED` order → ignored, **warning** (conflict).
- `CANCELLED` order → ignored, informational log.
- Malformed / unknown order: as for `inventory.stock-reserved`.

## Example

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
