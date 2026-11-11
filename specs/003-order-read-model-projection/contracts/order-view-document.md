# Contract: `order_views` document (read model)

**Store**: MongoDB, the database named in `MONGO_URI`, collection `order_views`
**Writer**: `ecommerce-orders` projection only (`OrderProjectionService`). No other writer.
**Readers**: future GraphQL query handlers (US-06/07). Readers MUST treat it as read-only.
**Consistency**: eventually consistent with the PostgreSQL write model (see ADR 0001).

## Example: after OrderPlaced then OrderCancelled from a failed payment

```json
{
  "_id": "532ab1d2-10d9-428e-b7d5-35c41b8154c3",
  "orderId": "532ab1d2-10d9-428e-b7d5-35c41b8154c3",
  "customerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "CANCELLED",
  "items": [
    { "productId": "p-2", "quantity": 3, "unitPrice": 5000, "subtotal": 15000 }
  ],
  "totalAmount": 15000,
  "placedAt": { "$date": "2026-11-11T16:52:55.850Z" },
  "confirmedAt": null,
  "cancelledAt": { "$date": "2026-11-11T16:52:55.899Z" },
  "cancellationReason": "Amount 15000 USD exceeds the maximum allowed threshold of 10000.00 USD.",
  "updatedAt": { "$date": "2026-11-11T16:52:55.899Z" },
  "appliedEventIds": ["5e0c…", "d6740c1b-7194-4cb6-8e2b-6f0d37359a36"],
  "statusEventId": "d6740c1b-7194-4cb6-8e2b-6f0d37359a36",
  "revision": 2
}
```

## Example: OrderConfirmed projected before OrderPlaced arrived

```json
{
  "_id": "8cf4…", "orderId": "8cf4…", "customerId": "3fa8…",
  "status": "CONFIRMED",
  "items": null, "totalAmount": null, "placedAt": null,
  "confirmedAt": { "$date": "…" }, "cancelledAt": null, "cancellationReason": null,
  "updatedAt": { "$date": "…" },
  "appliedEventIds": ["…"], "statusEventId": "…", "revision": 1
}
```

Once OrderPlaced is applied, `items`, `totalAmount` and `placedAt` are filled in and `status`
stays `CONFIRMED`.

## Field guarantees for readers

| Field | Guarantee |
|---|---|
| `status` | One of `PENDING`, `CONFIRMED`, `CANCELLED`. Never goes back to `PENDING`. |
| `items`, `totalAmount`, `placedAt` | All three `null`, or all three set (they come from the same event). |
| `confirmedAt` / `cancelledAt` | At most one is non-null, and it matches `status`. |
| `cancellationReason` | Non-null only when `status = CANCELLED` and the cancellation carried a reason (may be `""`). |
| `updatedAt` | Latest event time, not the projection time. |
| `appliedEventIds`, `statusEventId`, `revision` | **Internal** projection bookkeeping. Readers SHOULD NOT expose them through GraphQL. |

## Change policy

Adding a field is non-breaking. Renaming or removing a field, or changing the meaning of a
status, requires updating this contract, `docs/read-model.md`, and the GraphQL stories that read
it. Because the model is derived, a breaking change is deployed by **rebuilding**: drop the
collection, then reset the projection group to earliest.
