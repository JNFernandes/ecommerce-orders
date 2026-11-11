# Contract: `PaymentProcessed` (consumed)

**Topic**: `payments.payment-processed`
**Direction**: Inbound. `ecommerce-orders` is a consumer; `ecommerce-payments` is the producer.
**Upstream source of truth**: `ecommerce-payments/specs/001-process-payment/contracts/payments.payment-processed.md`
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
  "amount": 129.99,
  "currency": "USD",
  "processedAt": "2026-07-09T14:32:01Z"
}
```

| Field | Type | Required **by this consumer** | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key (`processed_events.eventId`). |
| `occurredAt` | ISO 8601 | no | Not used. |
| `aggregateId` | UUID | yes | **The payment id.** Logged and stored as `paymentId`. **Never** used as an order id. |
| `version` | int | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order to confirm.** |
| `amount` | decimal | no | Not used (Payments owns the amount check). |
| `currency` | string(3) | no | Not used. |
| `processedAt` | ISO 8601 | no | Not used. |

Unknown extra fields are ignored.

## Consumer behaviour

| Order status (looked up by `orderId`) | Effect | Event published | Log |
|---|---|---|---|
| `PENDING` | → `CONFIRMED` (same write flow as `POST /orders/:id/confirm`) | exactly one `OrderConfirmed` | info |
| `CONFIRMED` | none | none | debug |
| `CANCELLED` | none (any refund is a Payments concern) | none | **warn**, with `orderId`, `paymentId`, `eventId` |
| no such order | retried with backoff, then dead-lettered (`RETRIES_EXHAUSTED`) | none | warn on each retry, error on dead-letter |

- **Duplicate `eventId`**: acknowledged with no effect.
- **Malformed** (not JSON; `eventId`, `orderId` or `aggregateId` missing or not a UUID; `version`
  ≠ 1): dead-lettered (`MALFORMED`) with no retry.
- **Offset commit**: only after the state change plus processed record, the no-op record, or the
  dead-letter row has been saved.
