# US-01: Place an Order

## User Story

**As a** customer,
**I want to** place an order with one or more items,
**So that** the purchase process begins.

---

## Acceptance Criteria

### AC-01 — Valid order creation
- Customer provides: `customerId` (UUID), `items` (array of `productId`, `quantity`, `unitPrice`)
- Order is created with status `PENDING`
- Order total is calculated as the sum of (`quantity × unitPrice`) across all items
- Order is assigned a unique `orderId` (UUID)
- Order is persisted to the write database (PostgreSQL) before any event is published
- After successful DB save, `OrderPlaced` event is published to Kafka topic `orders.order-placed`
- Returns `HTTP 201 Created` with `{ orderId }`

### AC-02 — Input validation
- `customerId` is required and must be a valid UUID
- `items` must be a non-empty array
- Each item must have `productId` (non-empty string), `quantity` (integer > 0), `unitPrice` (number > 0)
- Returns `HTTP 400 Bad Request` with validation errors if any rule is violated

### AC-03 — Write flow integrity
- PostgreSQL save MUST succeed before Kafka publish is attempted
- If DB save fails → return `HTTP 500`, no Kafka message emitted
- If Kafka publish fails after successful DB save → return `HTTP 201` (save succeeded), log error, store failed event in dead-letter table for retry
- Kafka failure MUST NOT cause a 500 response to the client

### AC-04 — OrderPlaced event payload
The Kafka event published to `orders.order-placed` MUST include:
```json
{
  "eventId": "uuid",
  "occurredAt": "ISO 8601 timestamp",
  "aggregateId": "orderId (uuid)",
  "version": 1,
  "customerId": "uuid",
  "items": [
    {
      "productId": "string",
      "quantity": "integer",
      "unitPrice": "number"
    }
  ],
  "totalAmount": "number"
}
```

---

## REST Endpoint

```
POST /orders
Content-Type: application/json
```

### Request body
```json
{
  "customerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "items": [
    {
      "productId": "prod-001",
      "quantity": 2,
      "unitPrice": 29.99
    }
  ]
}
```

### Response — 201 Created
```json
{
  "orderId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

### Response — 400 Bad Request
```json
{
  "statusCode": 400,
  "message": ["items must not be empty", "quantity must be greater than 0"],
  "error": "Bad Request"
}
```

---

## Domain Model

### Order (Aggregate Root)
```
orderId       UUID          generated on creation
customerId    UUID          from request
status        OrderStatus   PENDING on creation
items         OrderItem[]   value objects
totalAmount   number        calculated from items
createdAt     Date          set on creation
updatedAt     Date          set on creation
```

### OrderItem (Value Object)
```
productId     string
quantity      integer > 0
unitPrice     number > 0
subtotal      number        quantity × unitPrice
```

### OrderStatus (Enum)
```
PENDING
CONFIRMED
CANCELLED
```

### Domain method
```
Order.place(customerId, items) → Order
  - validates items are not empty
  - validates each item quantity > 0 and unitPrice > 0
  - calculates totalAmount
  - sets status to PENDING
  - raises OrderPlaced domain event
```

---

## Architecture mapping

```
POST /orders
    │
    ▼
OrdersController          presentation/rest/
    │  PlaceOrderDto
    ▼
PlaceOrderCommand         application/commands/place-order/
    │
    ▼
PlaceOrderHandler         application/commands/place-order/
    │  calls Order.place()
    ▼
Order (domain)            domain/
    │  raises OrderPlaced domain event
    ▼
OrderRepository           infrastructure/persistence/
    │  saves to write DB (PostgreSQL)
    ▼
OrderEventsProducer       infrastructure/kafka/
    │  publishes to orders.order-placed
    ▼
Kafka
    │
    ▼
OrderProjection           infrastructure/projections/
    │  consumes OrderPlaced
    ▼
Read DB (PostgreSQL)      updates read model
```

---

## Testing Requirements

### Unit tests

| Test | Description |
|------|-------------|
| UT-01 | `Order.place()` creates order with PENDING status |
| UT-02 | `Order.place()` calculates totalAmount correctly |
| UT-03 | `Order.place()` raises OrderPlaced domain event |
| UT-04 | `Order.place()` throws if items array is empty |
| UT-05 | `Order.place()` throws if quantity <= 0 |
| UT-06 | `Order.place()` throws if unitPrice <= 0 |
| UT-07 | `PlaceOrderHandler` saves to DB before publishing to Kafka |
| UT-08 | `PlaceOrderHandler` does NOT publish to Kafka if DB save fails |
| UT-09 | `PlaceOrderHandler` returns orderId after successful save |
| UT-10 | `PlaceOrderHandler` stores event in dead-letter table if Kafka fails |

### Integration tests

| Test | Description |
|------|-------------|
| IT-01 | `POST /orders` with valid payload returns 201 and orderId |
| IT-02 | `POST /orders` with missing customerId returns 400 |
| IT-03 | `POST /orders` with invalid quantity returns 400 |
| IT-04 | `POST /orders` with invalid unitPrice returns 400 |
| IT-05 | `POST /orders` with empty items array returns 400 |
| IT-06 | `POST /orders` saves order correctly to write database |

### Component tests

| Test | Description |
|------|-------------|
| CT-01 | Full write flow: POST /orders → DB saved → OrderPlaced emitted to Kafka |
| CT-02 | Kafka publish failure does not return 500 to client |
| CT-03 | Order appears in read model after projection processes OrderPlaced |

### Test naming convention
```
"should [expected behaviour] when [condition]"

Examples:
"should create order with PENDING status when valid items are provided"
"should not publish to Kafka when DB save fails"
"should return 400 when items array is empty"
```

---

## Out of scope

- Payment processing (US-04 — Payments service)
- Stock reservation (US-02 — Inventory service)
- Order confirmation (US-03)
- Order cancellation (US-02)
- Authentication / authorisation
- Customer validation (customer existence not checked in this service)

---

## Branch

```
feature/US-01-place-order
```

Created from `main` before any implementation begins.

---

## Definition of Done

- [ ] Branch `feature/US-01-place-order` created from main
- [ ] `Order` aggregate with `place()` method implemented
- [ ] `PlaceOrderCommand` and `PlaceOrderHandler` implemented
- [ ] `OrdersController` POST /orders endpoint implemented
- [ ] `PlaceOrderDto` with validation decorators implemented
- [ ] `OrderRepository` saves to write DB
- [ ] `OrderEventsProducer` publishes to Kafka after DB save
- [ ] `OrderProjection` updates read model
- [ ] All unit tests passing (UT-01 to UT-10)
- [ ] All integration tests passing (IT-01 to IT-06)
- [ ] All component tests passing (CT-01 to CT-03)
- [ ] `npm run build` passes
- [ ] `npm run lint` passes with zero errors
- [ ] `npm run format:check` passes
- [ ] JSDoc on all public classes and methods
- [ ] Swagger annotations on controller and DTO
- [ ] Kafka event payload documented
- [ ] PR references US-01