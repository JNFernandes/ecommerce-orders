# Event: `PaymentProcessed` (consumed)

**Topic**: `payments.payment-processed`

**Producer**: `ecommerce-payments`. Upstream contract:
`ecommerce-payments/specs/001-process-payment/contracts/payments.payment-processed.md`.

**Consumer in this service**: `PaymentEventsConsumer` (`src/infra/kafka/payment-events.consumer.ts`),
consumer group `KAFKA_GROUP_ID` (default `ecommerce-orders-consumer`). Introduced by US-04.

**Meaning**: the payment for an order succeeded. Orders confirms the order (saga step 3 in
[ADR 0003](../adr/0003-saga-by-choreography.md)).

## Payload

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

| Field | Type | Required here | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key, stored in `processed_events`. |
| `occurredAt` | ISO 8601 | no | Not used. |
| `aggregateId` | UUID | yes | **The payment id.** Logged and stored as `paymentId`. **Never used as an order id.** |
| `version` | integer | yes, must be `1` | Any other value means the message is malformed. |
| `orderId` | UUID | yes | **The order to confirm.** |
| `amount`, `currency`, `processedAt` | | no | Not used. |

Unknown extra fields are ignored. The message key (set by Payments to the payment id) is not used.

## What Orders does

| Order status (looked up by `orderId`) | Effect | Event published |
|---|---|---|
| `PENDING` | → `CONFIRMED`, through the same write flow as `POST /orders/:id/confirm` | exactly one `OrderConfirmed` |
| `CONFIRMED` | nothing (`IGNORED_ALREADY_CONFIRMED`) | none |
| `CANCELLED` | nothing, plus a warning log (`IGNORED_CONFLICT`); any refund is a Payments concern | none |
| no such order | retried with backoff, then dead-lettered (`RETRIES_EXHAUSTED`) and retried later by the dead-letter worker | none |

## Delivery guarantees

- **Idempotent**: a message whose `eventId` is already in `processed_events` is acknowledged with
  no effect. For a state change, the status update and the `processed_events` row are saved in
  one transaction, and the update only applies while the order is still `PENDING`.
- **Offsets** are committed only after the outcome has been saved (state change, no-op record or
  dead-letter row).
- **Malformed** messages (not JSON; `eventId`, `orderId` or `aggregateId` missing or not a UUID;
  `version` ≠ 1) are dead-lettered immediately with no retry.
- **Other failures** are retried with exponential backoff (`PAYMENT_CONSUMER_MAX_ATTEMPTS`,
  `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, `PAYMENT_CONSUMER_BACKOFF_MAX_MS`) and then dead-lettered.
- Dead letters go to the `consumed_message_dead_letters` table, which is separate from the
  outbound `order_dead_letters`. The dead-letter worker re-handles `RETRIES_EXHAUSTED` rows
  through the same consumer logic (so dedupe still applies) with growing delays, until they
  resolve or are marked `EXHAUSTED` ([dead-letter-retry.md](../dead-letter-retry.md)).
  Malformed messages are stored `EXHAUSTED` and never retried.
- If publishing `OrderConfirmed` fails after the save, the event goes to `order_dead_letters` and
  the payment message still counts as processed.
