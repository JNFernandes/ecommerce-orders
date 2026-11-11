# Source Layout

This service is organized by **technical layer first**, not by bounded context — there is
currently one bounded context (orders), so a per-context split would just be indirection.
Files are named by entity/feature (`orders.controller.ts`, `place-order.service.ts`,
`order.repository.ts`) so the layer a file lives in and the thing it's about are both visible
at a glance.

| Folder | Layer (per the project constitution) | Contents |
|---|---|---|
| `controllers/` | Controller | `OrdersController` — HTTP I/O only, no business logic |
| `commands/` | — | CQRS command objects (e.g. `PlaceOrderCommand`) — plain data, dispatched via `CommandBus` |
| `services/` | Service | `PlaceOrderService`, `CancelOrderService`, `ConfirmOrderService` — orchestrate a command: call the domain, then the repository, then Kafka. Each registered as a CQRS `@CommandHandler` |
| `domain/` | Domain | `Order` aggregate (`place()`, `cancel()`, `confirm()`), `OrderItem` value object, `OrderPlaced`/`OrderCancelled`/`OrderConfirmed` events, `OrderValidationError`/`OrderCancellationError`/`OrderConfirmationError` — pure business logic, no I/O, no framework dependency |
| `dto/` | — | Request/response shapes validated with `class-validator` (`PlaceOrderDto`) and documented with Swagger |
| `repositories/` | Repository | Thin persistence classes (`OrderRepository`, `CustomerRepository`, `OrderDeadLetterRepository`) — map domain objects to/from TypeORM entities |
| `infra/database/` | Infrastructure | TypeORM entities (`entities/`), the migration that creates the schema (`migrations/`), a local dev seed script (`seeds/`), and the CLI `DataSource` config |
| `infra/kafka/` | Infrastructure | `KafkaModule` (producer connection wiring), `OrderEventsProducer`. Consumers (payment events, read-model projection) are planned, not yet built |
| `config/` | — | Environment configuration loader used by `ConfigModule` |

## Where a request goes

`OrdersController` → `CommandBus` (routes by the `@CommandHandler(PlaceOrderCommand)` decorator,
not a direct reference) → `PlaceOrderService` → `Order.place()` (domain) → `OrderRepository.save()`
(DB) → `OrderEventsProducer.publishOrderPlaced()` (Kafka). If the Kafka publish fails, it's
caught inside `PlaceOrderService` and written to `OrderDeadLetterRepository` instead of failing
the request.

## Kafka consumers and the read model (planned, not yet built)

Today the service only **produces** events. Per the constitution (Principles II and VII) and
[ADR 0001](../docs/adr/0001-cqrs-read-model-in-orders-service.md) /
[ADR 0003](../docs/adr/0003-saga-by-choreography.md), it will also consume:

- `payments.payment-processed` and `payments.payment-failed`, to confirm or cancel the order
  identified by the event's `orderId`. The `aggregateId` of a payment event is the payment id,
  never the order id.
- Its own `orders.*` events, through a projection that builds a **MongoDB read model**. GraphQL
  query handlers will read only from that model, never from PostgreSQL, and its schemas will not
  reuse the TypeORM entities in `infra/database/entities/`.

All consumers will be idempotent (dedupe by `eventId`), commit offsets only after their DB save
succeeds, retry with exponential backoff and then dead-letter. None of this code exists yet, and
there is no GraphQL resolver or MongoDB connection in `src/` today.

## Endpoints and domain events

| Method | Path | Description |
|---|---|---|
| `POST` | `/orders` | Places a new order. See `specs/001-place-order/contracts/rest-place-order.md`. |
| `POST` | `/orders/:orderId/cancel` | Cancels a `PENDING` order (`404` if not found, `409` if not `PENDING`). See `docs/us-02-cancel-order.md`. |
| `POST` | `/orders/:orderId/confirm` | Confirms a `PENDING` order, e.g. after payment (`404` if not found, `409` if not `PENDING`). See `docs/us-03-confirm-order.md`. |

| Event | Topic | Produced/Consumed |
|---|---|---|
| `OrderPlaced` | `orders.order-placed` | Produced by `OrderEventsProducer` after a successful DB save. Will also be consumed by the planned read-model projection — see `specs/001-place-order/contracts/event-order-placed.md` and `docs/events/order-placed.md`. |
| `OrderCancelled` | `orders.order-cancelled` | Produced by `OrderEventsProducer` after a successful status-update save. Will also be consumed by the planned read-model projection — see `docs/events/order-cancelled.md`. |
| `OrderConfirmed` | `orders.order-confirmed` | Produced by `OrderEventsProducer` after a successful status-update save. Will also be consumed by the planned read-model projection — see `docs/events/order-confirmed.md`. |
| `PaymentProcessed` | `payments.payment-processed` | **Planned consumer** — confirms the order referenced by `orderId`. Produced by `ecommerce-payments`. |
| `PaymentFailed` | `payments.payment-failed` | **Planned consumer** — cancels the order referenced by `orderId`. Produced by `ecommerce-payments`. |
