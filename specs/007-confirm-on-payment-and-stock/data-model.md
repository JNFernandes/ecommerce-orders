# Data Model: Confirm on Payment and Stock (US-09)

## Order (aggregate root, `src/domain/order.aggregate.ts`)

| Field | Type | Change | Notes |
|---|---|---|---|
| `id` | UUID | — | |
| `customerId` | UUID | — | |
| `status` | `OrderStatus` | — | `PENDING`, `CONFIRMED`, `CANCELLED` |
| `paymentOutcome` | `PaymentOutcome` | **new** | `PENDING` on `place()` |
| `stockOutcome` | `StockOutcome` | **new** | `PENDING` on `place()` |
| `cancellationReason` | string \| null | values change | `payment failed: …`, `stock rejected: …`, or null (REST cancel) |
| `items`, `totalAmount`, `createdAt`, `updatedAt` | — | — | |

`reconstitute(...)` gains `paymentOutcome` and `stockOutcome` (defaulting to `PENDING`, so
existing call sites and tests compile).

### Enums

- `PaymentOutcome` (`src/domain/payment-outcome.enum.ts`, extended): `PENDING`, `PROCESSED`,
  `FAILED`.
- `StockOutcome` (`src/domain/stock-outcome.enum.ts`, new): `PENDING`, `RESERVED`, `REJECTED`.

### Outcome methods and their result

```text
recordPaymentProcessed(): OutcomeApplication
recordPaymentFailed(reason?: string): OutcomeApplication
recordStockReserved(): OutcomeApplication
recordStockRejected(reason?: string): OutcomeApplication

OutcomeApplication = { record: OutcomeRecord, attention: Attention }

OutcomeRecord =                     // decided by the domain; stored 1:1 in processed_events.outcome
  | RECORDED                        // first positive outcome, still PENDING, no event
  | CONFIRMED                       // OrderConfirmed raised
  | CANCELLED                       // OrderCancelled raised (with reason)
  | IGNORED_DUPLICATE               // same outcome already recorded on a PENDING order
  | IGNORED_ALREADY_CONFIRMED
  | IGNORED_ALREADY_CANCELLED
  | IGNORED_CONFLICT                // contradicts a final status or a recorded outcome

Attention = NONE | REFUND_NEEDED | CONFLICT   // NONE for every non-ignored record
```

`OutcomeRecord` (`src/domain/outcome-application.ts`) is a domain enum. The repository maps
it to the entity enum `ProcessedEventOutcome` by name (persistence mapping only). The service
copies `record` and logs at warning level when `attention ≠ NONE`; it makes no classification
of its own (constitution Principle I).

### Transition rules

On a `PENDING` order (outcomes `p`, `s`):

| Incoming | Condition | Effect | Result |
|---|---|---|---|
| payment processed | `p = PROCESSED` | none | IGNORED_DUPLICATE / NONE |
| payment processed | `p = PENDING`, `s = PENDING` | `p := PROCESSED` | RECORDED / NONE |
| payment processed | `p = PENDING`, `s = RESERVED` | `p := PROCESSED`, status `CONFIRMED` | CONFIRMED / NONE |
| payment failed | `p = PENDING` | `p := FAILED`, status `CANCELLED`, reason `payment failed[: r]` | CANCELLED / NONE |
| payment failed | `p = PROCESSED` | none (first payment outcome wins) | IGNORED_CONFLICT / CONFLICT |
| stock reserved | `s = RESERVED` | none | IGNORED_DUPLICATE / NONE |
| stock reserved | `s = PENDING`, `p = PENDING` | `s := RESERVED` | RECORDED / NONE |
| stock reserved | `s = PENDING`, `p = PROCESSED` | `s := RESERVED`, status `CONFIRMED` | CONFIRMED / NONE |
| stock rejected | `s = PENDING` | `s := REJECTED`, status `CANCELLED`, reason `stock rejected[: r]` | CANCELLED / NONE |
| stock rejected | `s = RESERVED` | none (first stock outcome wins) | IGNORED_CONFLICT / CONFLICT |

(`p = FAILED` or `s = REJECTED` cannot coexist with `PENDING` status: a negative outcome always
cancels.)

On a non-`PENDING` order nothing changes:

| Status | Incoming | record | attention |
|---|---|---|---|
| CONFIRMED | payment processed, stock reserved | IGNORED_ALREADY_CONFIRMED | NONE |
| CONFIRMED | payment failed, stock rejected | IGNORED_CONFLICT | CONFLICT |
| CANCELLED | payment processed | IGNORED_CONFLICT | REFUND_NEEDED |
| CANCELLED | payment failed, stock reserved, stock rejected | IGNORED_ALREADY_CANCELLED | NONE |

Manual `confirm()` / `cancel()` (REST) are unchanged: they act on `PENDING` only, throw otherwise,
and do not touch the outcomes.

### Processed-event outcome (persistence)

`processed_events.outcome` stores `OutcomeRecord` by name. Two values are new to the column type:
`RECORDED` and `IGNORED_DUPLICATE`; the other five already exist (US-04).

## Persistence

### `orders` (changed)

| Column | Type | Default | Backfill |
|---|---|---|---|
| `"paymentOutcome"` | `orders_paymentoutcome_enum` NOT NULL | `'PENDING'` | `'PROCESSED'` where `status = 'CONFIRMED'` |
| `"stockOutcome"` | `orders_stockoutcome_enum` NOT NULL | `'PENDING'` | `'RESERVED'` where `status = 'CONFIRMED'` |

Outcome write (`OrderRepository.applyOutcome`), in one transaction:

```text
UPDATE orders SET status, "paymentOutcome", "stockOutcome", "cancellationReason", "updatedAt"
 WHERE id = :id AND status = 'PENDING'
   AND "paymentOutcome" = :loadedPayment AND "stockOutcome" = :loadedStock
-- affected = 0 → OrderStatusChangedConcurrentlyError (retryable)
INSERT INTO processed_events (...)      -- unique eventId → EventAlreadyProcessedError
```

### `processed_events` (changed)

| Column | Change |
|---|---|
| `"paymentId"` | now NULL-able |
| `"reservationId"` uuid NULL | **new** |
| CHECK `num_nonnulls("paymentId", "reservationId") = 1` | **new** |
| `outcome` enum | adds `RECORDED`, `IGNORED_DUPLICATE` |

### `consumed_message_dead_letters` (unchanged)

Stock messages are stored with their topic, raw value, `eventId` and `orderId`, exactly like
payment messages; the retry worker routes them by topic to `InventoryEventsConsumer`.

## Inbound reference (`src/commands/inbound-event-ref.ts`)

| Field | Change |
|---|---|
| `eventId`, `topic`, `orderId` | — |
| `paymentId?` | now optional |
| `reservationId?` | **new**, from a stock message's `aggregateId`; never an order id |

## Read side

No change. `order_views` and GraphQL keep deriving status from `OrderConfirmed` /
`OrderCancelled`; the outcomes are not projected (FR-023).
