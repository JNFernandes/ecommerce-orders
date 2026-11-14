# Produced event delta: `orders.order-cancelled` and `orders.order-confirmed`

No field is added, removed or renamed; `version` stays `1`. Only the values and the moment of
publication change.

## `orders.order-cancelled`

| Field | Before (US-04) | After (US-09) |
|---|---|---|
| `reason` | the raw payment failure reason; omitted for REST cancels | `payment failed: <reason>` or `stock rejected: <reason>` (no suffix when the source reason is empty); still omitted for REST cancels |

Published as soon as the first negative outcome arrives for a `PENDING` order.

## `orders.order-confirmed`

Payload unchanged. Published when the second positive outcome arrives (payment processed **and**
stock reserved), or by the manual confirm endpoint. No longer published on
`payments.payment-processed` alone.

## Consumers affected

- Payments and Inventory compensate on `OrderCancelled` whatever the reason; no change.
- The Orders read model stores `reason` as `cancellationReason`; it now shows the prefixed text.
  No schema change.
- `ecommerce-infra/docs/events.md` (`orders.order-cancelled.reason`: "today: payment failures")
  needs updating in the infra repo.
