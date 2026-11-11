# Contract: `PaymentFailed` (consumed)

**Topic**: `payments.payment-failed`
**Direction**: Inbound. `ecommerce-orders` is a consumer; `ecommerce-payments` is the producer.
**Upstream source of truth**: `ecommerce-payments/specs/002-handle-payment-failure/contracts/payments.payment-failed.md`
**Consumer group**: `KAFKA_GROUP_ID` (default `ecommerce-orders-consumer`)
**Message key**: the payment id (set by Payments). It is not used by this service for routing.

## Payload (JSON)

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

| Field | Type | Required **by this consumer** | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key. |
| `occurredAt` | ISO 8601 | no | Not used. |
| `aggregateId` | UUID | yes | **The payment id.** Logged and stored as `paymentId`. **Never** used as an order id. |
| `version` | int | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order to cancel.** |
| `reason` | string | no (free text) | Stored as `orders.cancellationReason` and carried on `OrderCancelled.reason`. Missing or `null` is stored as `''`. |
| `failedAt` | ISO 8601 | no | Not used. |

Unknown extra fields are ignored.

## Consumer behaviour

| Order status (looked up by `orderId`) | Effect | Event published | Log |
|---|---|---|---|
| `PENDING` | → `CANCELLED`, `cancellationReason = reason` (same write flow as `POST /orders/:id/cancel`) | exactly one `OrderCancelled` with `reason` | info |
| `CANCELLED` | none | none | debug |
| `CONFIRMED` | none | none | **warn**, with `orderId`, `paymentId`, `eventId` |
| no such order | retried with backoff, then dead-lettered (`RETRIES_EXHAUSTED`) | none | warn on each retry, error on dead-letter |

Duplicate, malformed and offset-commit rules are identical to
[event-payment-processed.md](event-payment-processed.md).
