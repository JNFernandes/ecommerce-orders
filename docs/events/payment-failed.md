# Event: `PaymentFailed` (consumed)

**Topic**: `payments.payment-failed`

**Producer**: `ecommerce-payments`. Upstream contract:
`ecommerce-payments/specs/002-handle-payment-failure/contracts/payments.payment-failed.md`.

**Consumer in this service**: `PaymentEventsConsumer` (`src/infra/kafka/payment-events.consumer.ts`),
consumer group `KAFKA_GROUP_ID` (default `ecommerce-orders-consumer`). Introduced by US-04.

**Meaning**: the payment for an order failed (today, the amount was over the Payments policy
threshold). Orders cancels the order at once, whatever the stock outcome, and keeps the reason
([ADR 0006](../adr/0006-order-joins-payment-and-stock-outcomes.md), extending
[ADR 0003](../adr/0003-saga-by-choreography.md)).

## Payload

```json
{
  "eventId": "9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3",
  "occurredAt": "2026-07-09T14:32:01Z",
  "aggregateId": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "version": 1,
  "orderId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "reason": "Amount 15000.00 USD exceeds the maximum allowed threshold of 10000.00 USD.",
  "failedAt": "2026-07-09T14:32:01Z"
}
```

| Field | Type | Required here | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key, stored in `processed_events`. |
| `occurredAt` | ISO 8601 | no | Not used. |
| `aggregateId` | UUID | yes | **The payment id.** Logged and stored as `paymentId`. **Never used as an order id.** |
| `version` | integer | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order to cancel.** |
| `reason` | string | no (free text) | Stored as `orders.cancellationReason = "payment failed: <reason>"` and carried on `OrderCancelled.reason` (since US-09; before, the bare reason). Missing, `null` or empty gives just `payment failed`. Any non-string value means the message is malformed. |
| `failedAt` | ISO 8601 | no | Not used. |

Unknown extra fields are ignored. The message key (set by Payments to the payment id) is not used.

## What Orders does

| Order (looked up by `orderId`) | Effect | Event published | `processed_events.outcome` |
|---|---|---|---|
| `PENDING`, payment pending (any stock outcome) | payment outcome → `FAILED`, order → `CANCELLED` with `payment failed: <reason>` | exactly one `OrderCancelled`, with that `reason` | `CANCELLED` |
| `PENDING`, payment already processed | nothing, plus a **warning**: the first payment outcome wins | none | `IGNORED_CONFLICT` |
| `CANCELLED` | nothing, informational log | none | `IGNORED_ALREADY_CANCELLED` |
| `CONFIRMED` | nothing, plus a **warning** (conflict) | none | `IGNORED_CONFLICT` |
| no such order | retried with backoff, then dead-lettered (`RETRIES_EXHAUSTED`) and retried later by the dead-letter worker | none | — |

The rules live in the `Order` aggregate (`recordPaymentFailed()`).

## Delivery guarantees

Identical to [payment-processed.md](payment-processed.md#delivery-guarantees): dedupe by
`eventId`, offsets committed only after the outcome is saved, malformed messages dead-lettered
immediately, and other failures retried with backoff, dead-lettered, then retried by the
dead-letter worker ([dead-letter-retry.md](../dead-letter-retry.md)).
