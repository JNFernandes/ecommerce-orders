# Contract change: `OrderCancelled` gains an optional `reason` (produced)

**Topic**: `orders.order-cancelled` (unchanged)
**Version**: stays `1`. The change is additive and non-breaking (Constitution Principle VII).
**Current contract**: `docs/events/order-cancelled.md` (to be updated by this feature).

## New field

| Field | Type | Presence | Semantics |
|---|---|---|---|
| `reason` | string | **Optional.** Present only when the cancellation carried a reason, which today means only cancellations triggered by `payments.payment-failed`. | The payment failure reason as given by Payments (free text, may be `""`). |

## Examples

Cancelled through `POST /orders/:orderId/cancel` (unchanged, byte-identical to today):

```json
{ "eventId": "…", "occurredAt": "…", "aggregateId": "<orderId>", "version": 1, "customerId": "…" }
```

Cancelled because the payment failed:

```json
{
  "eventId": "…", "occurredAt": "…", "aggregateId": "<orderId>", "version": 1, "customerId": "…",
  "reason": "Amount 15000.00 USD exceeds the maximum allowed threshold of 10000.00 USD."
}
```

## Compatibility

Existing consumers that ignore unknown fields are unaffected. Consumers must treat a missing
`reason` as "no reason given".
