# US-02: Cancel an Order

**Note**: Unlike US-01, this feature was implemented directly without a full spec-kit cycle
(no `specs/002-*/spec.md`/`plan.md`/`tasks.md`) — it's a small, well-bounded addition to the
existing `Order` aggregate. This doc is the equivalent reference brief, written to match the
actual implementation, so there's a canonical place to look up real endpoint/payload shapes
(including realistic example values) instead of guessing or reusing US-01's placeholders.

## User Story

**As a** customer,
**I want to** cancel a pending order,
**So that** I am not charged for something I no longer want.

---

## Acceptance Criteria

### AC-01 — Valid cancellation
- `orderId` provided as a path parameter (UUID)
- The order must exist and currently have status `PENDING`
- Order status is updated to `CANCELLED`
- The status change is persisted to the write database (PostgreSQL) before any event is published
- After the successful DB update, `OrderCancelled` event is published to Kafka topic `orders.order-cancelled`
- Returns `HTTP 200 OK` with `{ orderId, status }`

### AC-02 — Order not found
- If `orderId` does not correspond to an existing order, returns `HTTP 404 Not Found`
- If `orderId` is not a syntactically valid UUID, returns `HTTP 400 Bad Request` (caught by `ParseUUIDPipe` before any lookup)

### AC-03 — Invalid state transition
- If the order's current status is not `PENDING` (i.e. already `CONFIRMED` or already `CANCELLED`), returns `HTTP 409 Conflict`
- No DB change and no Kafka event are produced when this check fails

### AC-04 — Write flow integrity
- The status update MUST succeed in PostgreSQL before Kafka publish is attempted
- If the DB update fails → return `HTTP 500`, no Kafka message emitted
- If Kafka publish fails after a successful DB update → return `HTTP 200` (the cancellation itself succeeded), log the error, store the failed event in the dead-letter table for retry
- Kafka failure MUST NOT cause a 500 response to the client

### AC-05 — OrderCancelled event payload
The Kafka event published to `orders.order-cancelled` MUST include:
```json
{
  "eventId": "uuid",
  "occurredAt": "ISO 8601 timestamp",
  "aggregateId": "orderId (uuid)",
  "version": 1,
  "customerId": "uuid"
}
```

---

## REST Endpoint

```
POST /orders/:orderId/cancel
```

### Response — 200 OK
```json
{
  "orderId": "8107b8fe-b0ca-497d-8f41-e55010fbfa4d",
  "status": "CANCELLED"
}
```

### Response — 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Order not found",
  "error": "Not Found"
}
```

### Response — 409 Conflict
```json
{
  "statusCode": 409,
  "message": "cannot cancel order with status CONFIRMED; only a PENDING order can be cancelled",
  "error": "Conflict"
}
```

### Response — 400 Bad Request (malformed orderId)
```json
{
  "statusCode": 400,
  "message": "Validation failed (uuid is expected)",
  "error": "Bad Request"
}
```

---

## Domain Model

### Domain method (added to the existing `Order` aggregate from US-01)
```
Order.cancel() → void
  - throws OrderCancellationError if status is not currently PENDING
  - sets status to CANCELLED
  - updates updatedAt
  - raises OrderCancelled domain event
```

No new entities — this extends the `Order` aggregate already defined in `docs/us-01-place-order.md`.

---

## Architecture mapping

```
POST /orders/:orderId/cancel
    │
    ▼
OrdersController          src/controllers/
    ▼
CancelOrderCommand        src/commands/
    ▼
CancelOrderService        src/services/
    │  loads the order via OrderRepository.findById()
    │  calls Order.cancel()
    ▼
Order (domain)            src/domain/
    │  raises OrderCancelled domain event
    ▼
OrderRepository           src/repositories/
    │  updateStatus() — write DB (PostgreSQL)
    ▼
OrderEventsProducer       src/infra/kafka/
    │  publishes to orders.order-cancelled
    ▼
Kafka
```

Same producer-only boundary as US-01: no consumer or read model in this repo (see
`docs/us-01-place-order.md` and `specs/001-place-order/research.md`).

---

## Testing Requirements

### Unit tests (`tests/unit/domain/order.aggregate.spec.ts`, `tests/unit/services/cancel-order.service.spec.ts`)

| Test | Description |
|------|-------------|
| UT-13 | `Order.cancel()` transitions a PENDING order to CANCELLED |
| UT-14 | `Order.cancel()` raises an OrderCancelled domain event |
| UT-15 | `Order.cancel()` throws OrderCancellationError when already CANCELLED |
| UT-16 | `CancelOrderService` updates order status before publishing to Kafka |
| UT-17 | `CancelOrderService` throws NotFoundException when the order does not exist |
| UT-18 | `CancelOrderService` throws OrderCancellationError when the order is already cancelled |
| UT-19 | `CancelOrderService` does NOT publish to Kafka if the status update fails |
| UT-20 | `CancelOrderService` stores event in dead-letter table if Kafka publish fails, and still succeeds |

### Integration tests (`tests/integration/cancel-order.integration.spec.ts`)

| Test | Description |
|------|-------------|
| IT-09 | `POST /orders/:orderId/cancel` on a PENDING order returns 200 and CANCELLED status |
| IT-10 | `POST /orders/:orderId/cancel` returns 404 when the order does not exist |
| IT-11 | `POST /orders/:orderId/cancel` returns 400 when orderId is not a valid UUID |
| IT-12 | `POST /orders/:orderId/cancel` returns 409 when the order is already cancelled |
| IT-13 | `POST /orders/:orderId/cancel` returns 409 when the order is CONFIRMED (not PENDING) |

### Component tests (`tests/component/cancel-order.component.spec.ts`)

| Test | Description |
|------|-------------|
| CT-05 | Full write flow: cancel updates DB status → OrderCancelled emitted to Kafka |
| CT-06 | Cancelling an already-cancelled order returns 409 without touching Kafka |
| CT-07 | Kafka publish failure on cancel does not return 500 to client |

### Test naming convention

Same as US-01: `"should [expected behaviour] when [condition]"`.

---

## Out of scope

- Refund processing (a payments concern, not this service's)
- Cancelling a CONFIRMED order — only a PENDING order can be cancelled, per the user story
- Automatic/timeout-based cancellation — this is a customer-initiated action only
- Authentication / authorisation / ownership verification (same exclusion as US-01)

---

## Branch

```
feature/US-02-cancel-order
```

Created from `main` (after US-01 was merged) before implementation began.

---

## Definition of Done

- [x] Branch `feature/US-02-cancel-order` created from updated `main` (after US-01 merged)
- [x] `Order.cancel()` domain method implemented
- [x] `CancelOrderCommand` and `CancelOrderService` implemented
- [x] `OrdersController` `POST /orders/:orderId/cancel` endpoint implemented
- [x] `OrderRepository.findById()` and `OrderRepository.updateStatus()` implemented
- [x] `OrderEventsProducer.publishOrderCancelled()` publishes to Kafka after DB update
- [x] Dead-letter capture on Kafka publish failure (reuses `OrderDeadLetterRepository`)
- [x] All unit tests passing (UT-13 to UT-20)
- [x] All integration tests passing (IT-09 to IT-13)
- [x] All component tests passing (CT-05 to CT-07)
- [x] `npm run build` passes
- [x] `npm run lint` passes with zero errors
- [x] `npm run format:check` passes
- [x] JSDoc on all public classes and methods
- [x] Swagger annotations on controller and DTO
- [x] Kafka event payload documented (`docs/events/order-cancelled.md`)
- [ ] PR references US-02
