# US-03: Confirm an Order

**Note**: Like US-02, this was implemented directly without a full spec-kit cycle (no
`specs/003-*/spec.md`/`plan.md`/`tasks.md`) — same rationale: a narrow addition to the
existing `Order` aggregate, reusing US-01's established architecture.

**On the trigger mechanism**: the user story says *"As the system, I want to confirm an
order after payment is processed"* — but this is implemented as a synchronous REST endpoint
(`POST /orders/:orderId/confirm`), not a Kafka consumer of a payments event. A real
`ecommerce-payments` service is planned but doesn't exist yet, so there is no real event
contract to consume today, and this service is deliberately kept a Kafka **producer only**
(see `docs/us-01-place-order.md`, `specs/001-place-order/research.md`). Once
`ecommerce-payments` exists with a real, known event contract, a thin Kafka consumer can be
added that calls the exact same `ConfirmOrderCommand` this endpoint already dispatches — the
domain/application logic below does not change either way, only the trigger does.

## User Story

**As** the system,
**I want to** confirm an order after payment is processed,
**So that** the order moves to the confirmed state.

---

## Acceptance Criteria

### AC-01 — Valid confirmation
- `orderId` provided as a path parameter (UUID)
- The order must exist and currently have status `PENDING`
- Order status is updated to `CONFIRMED`
- The status change is persisted to the write database (PostgreSQL) before any event is published
- After the successful DB update, `OrderConfirmed` event is published to Kafka topic `orders.order-confirmed`
- Returns `HTTP 200 OK` with `{ orderId, status }`

### AC-02 — Order not found
- If `orderId` does not correspond to an existing order, returns `HTTP 404 Not Found`
- If `orderId` is not a syntactically valid UUID, returns `HTTP 400 Bad Request` (caught by `ParseUUIDPipe` before any lookup)

### AC-03 — Invalid state transition
- If the order's current status is not `PENDING` (i.e. already `CONFIRMED` or already `CANCELLED`), returns `HTTP 409 Conflict`
- No DB change and no Kafka event are produced when this check fails
- A `CONFIRMED` order can also no longer be cancelled — `POST /orders/:orderId/cancel` on it returns `409` too, since `Order.cancel()` has the same PENDING-only precondition

### AC-04 — Write flow integrity
- The status update MUST succeed in PostgreSQL before Kafka publish is attempted
- If the DB update fails → return `HTTP 500`, no Kafka message emitted
- If Kafka publish fails after a successful DB update → return `HTTP 200` (the confirmation itself succeeded), log the error, store the failed event in the dead-letter table for retry
- Kafka failure MUST NOT cause a 500 response to the client

### AC-05 — OrderConfirmed event payload
The Kafka event published to `orders.order-confirmed` MUST include:
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
POST /orders/:orderId/confirm
```

### Response — 200 OK
```json
{
  "orderId": "d66849bc-c0c2-4ede-b07a-e35ddbc8bc29",
  "status": "CONFIRMED"
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
  "message": "cannot confirm order with status CANCELLED; only a PENDING order can be confirmed",
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

### Domain method (added to the existing `Order` aggregate from US-01/US-02)
```
Order.confirm() → void
  - throws OrderConfirmationError if status is not currently PENDING
  - sets status to CONFIRMED
  - updates updatedAt
  - raises OrderConfirmed domain event
```

No new entities — this extends the `Order` aggregate already defined in `docs/us-01-place-order.md`.

---

## Architecture mapping

```
POST /orders/:orderId/confirm
    │
    ▼
OrdersController          src/controllers/
    ▼
ConfirmOrderCommand       src/commands/
    ▼
ConfirmOrderService       src/services/
    │  loads the order via OrderRepository.findById()
    │  calls Order.confirm()
    ▼
Order (domain)            src/domain/
    │  raises OrderConfirmed domain event
    ▼
OrderRepository           src/repositories/
    │  updateStatus() — write DB (PostgreSQL)
    ▼
OrderEventsProducer       src/infra/kafka/
    │  publishes to orders.order-confirmed
    ▼
Kafka
```

Same producer-only boundary as US-01/US-02: no consumer or read model in this repo.

---

## Testing Requirements

### Unit tests (`tests/unit/domain/order.aggregate.spec.ts`, `tests/unit/services/confirm-order.service.spec.ts`)

| Test | Description |
|------|-------------|
| UT-21 | `Order.confirm()` transitions a PENDING order to CONFIRMED |
| UT-22 | `Order.confirm()` raises an OrderConfirmed domain event |
| UT-23 | `Order.confirm()` throws OrderConfirmationError when already CONFIRMED |
| UT-24 | `Order.confirm()` throws OrderConfirmationError when already CANCELLED |
| UT-25 | `ConfirmOrderService` updates order status before publishing to Kafka |
| UT-26 | `ConfirmOrderService` throws NotFoundException when the order does not exist |
| UT-27 | `ConfirmOrderService` throws OrderConfirmationError when the order is already confirmed |
| UT-28 | `ConfirmOrderService` throws OrderConfirmationError when the order is already cancelled |
| UT-29 | `ConfirmOrderService` does NOT publish to Kafka if the status update fails |
| UT-30 | `ConfirmOrderService` stores event in dead-letter table if Kafka publish fails, and still succeeds |

### Integration tests (`tests/integration/confirm-order.integration.spec.ts`)

| Test | Description |
|------|-------------|
| IT-14 | `POST /orders/:orderId/confirm` on a PENDING order returns 200 and CONFIRMED status |
| IT-15 | `POST /orders/:orderId/confirm` returns 404 when the order does not exist |
| IT-16 | `POST /orders/:orderId/confirm` returns 400 when orderId is not a valid UUID |
| IT-17 | `POST /orders/:orderId/confirm` returns 409 when the order is already confirmed |
| IT-18 | `POST /orders/:orderId/confirm` returns 409 when the order is CANCELLED (not PENDING) |

### Component tests (`tests/component/confirm-order.component.spec.ts`)

| Test | Description |
|------|-------------|
| CT-08 | Full write flow: confirm updates DB status → OrderConfirmed emitted to Kafka |
| CT-09 | Confirming an already-confirmed order returns 409 without touching Kafka |
| CT-10 | Kafka publish failure on confirm does not return 500 to client |

### Test naming convention

Same as US-01/US-02: `"should [expected behaviour] when [condition]"`.

---

## Out of scope

- Any real integration with `ecommerce-payments` — that service doesn't exist yet; this endpoint is called manually/by a script/by ops for now
- A Kafka consumer trigger for confirmation — deferred until `ecommerce-payments`'s real event contract is known (see the note at the top of this doc)
- Authentication / authorisation / verifying the caller is actually authorized to confirm payment (same exclusion as US-01/US-02)

---

## Branch

```
feature/US-03-confirm-order
```

Created from `main` (after US-01 and US-02 were merged) before implementation began.

---

## Definition of Done

- [x] Branch `feature/US-03-confirm-order` created from updated `main`
- [x] `Order.confirm()` domain method implemented
- [x] `ConfirmOrderCommand` and `ConfirmOrderService` implemented
- [x] `OrdersController` `POST /orders/:orderId/confirm` endpoint implemented
- [x] `OrderEventsProducer.publishOrderConfirmed()` publishes to Kafka after DB update
- [x] Dead-letter capture on Kafka publish failure (reuses `OrderDeadLetterRepository`)
- [x] All unit tests passing (UT-21 to UT-30)
- [x] All integration tests passing (IT-14 to IT-18)
- [x] All component tests passing (CT-08 to CT-10)
- [x] `npm run build` passes
- [x] `npm run lint` passes with zero errors
- [x] `npm run format:check` passes
- [x] JSDoc on all public classes and methods
- [x] Swagger annotations on controller and DTO
- [x] Kafka event payload documented (`docs/events/order-confirmed.md`)
- [ ] PR references US-03
