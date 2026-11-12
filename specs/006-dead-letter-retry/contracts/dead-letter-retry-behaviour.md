# Contract: dead-letter retry behaviour

This is an internal contract: there is no new API. It describes what operators and other services
can rely on.

## Outbound (`order_dead_letters`)

| Guarantee | Detail |
|---|---|
| What is republished | The stored event: the same fields, values and **`eventId`**. Key order may differ, because Postgres `jsonb` does not keep it. |
| Where | The stored `topic` (`orders.order-placed`, `orders.order-confirmed` or `orders.order-cancelled`) |
| Message key | `payload.aggregateId` (the order id), as for the original publish |
| Delivery | At-least-once. Consumers (Payments, the read-model projection) deduplicate by `eventId` or `orderId`. |
| Ordering | Not guaranteed relative to the order's later events. The read model is order-independent (ADR 0004), and Payments only needs `OrderPlaced`. |

## Inbound (`consumed_message_dead_letters`)

| Topic | Re-handled by | Duplicate protection |
|---|---|---|
| `payments.payment-processed`, `payments.payment-failed` | `PaymentEventsConsumer.process` (parse, then `ReactToPaymentOutcomeCommand`) | `processed_events` by `eventId` |
| `orders.order-placed`, `orders.order-confirmed`, `orders.order-cancelled` | `OrderProjectionConsumer.process` (parse, then `OrderProjectionService.project`) | `appliedEventIds` on the view |
| anything else | none: `EXHAUSTED` | — |

A retry never creates a new dead-letter row and never commits a Kafka offset. A duplicate counts as
success, so the row is `RESOLVED`.

## States an operator sees

| `status` | Meaning | Worker action |
|---|---|---|
| `PENDING_RETRY` | Waiting; due at `nextRetryAt` | Retried |
| `RESOLVED` | Published or re-handled successfully at `resolvedAt` | None (kept for audit) |
| `EXHAUSTED` | Malformed, or failed `DEAD_LETTER_MAX_RETRIES` times; see `lastError` | None. An error was logged. Manual handling is out of scope. |

## Default schedule

| Failed attempt # | Next retry after |
|---|---|
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5 | 80 s |
| 6 | 160 s |
| 7 | 320 s |
| 8 | — (EXHAUSTED) |

The worker runs every 30 s, so a delay shorter than the interval is honoured at the next cycle.
The cap of 600 s only applies when the max-retries setting is higher than the default.

## Multi-instance

Each row is processed inside its own transaction with `SELECT … FOR UPDATE SKIP LOCKED`. Other
instances skip locked rows. If a process dies mid-attempt, its transaction rolls back and the row
is due again immediately.
