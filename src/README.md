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
| `services/` | Service | `PlaceOrderService` — orchestrates a command: calls the domain, then the repository, then Kafka. Registered as a CQRS `@CommandHandler` |
| `domain/` | Domain | `Order` aggregate, `OrderItem` value object, `OrderPlaced` event, `OrderValidationError` — pure business logic, no I/O, no framework dependency |
| `dto/` | — | Request/response shapes validated with `class-validator` (`PlaceOrderDto`) and documented with Swagger |
| `repositories/` | Repository | Thin persistence classes (`OrderRepository`, `CustomerRepository`, `OrderDeadLetterRepository`) — map domain objects to/from TypeORM entities |
| `infra/database/` | Infrastructure | TypeORM entities (`entities/`), the migration that creates the schema (`migrations/`), a local dev seed script (`seeds/`), and the CLI `DataSource` config |
| `infra/kafka/` | Infrastructure | `KafkaModule` (producer connection wiring), `OrderEventsProducer` |
| `config/` | — | Environment configuration loader used by `ConfigModule` |

## Where a request goes

`OrdersController` → `CommandBus` (routes by the `@CommandHandler(PlaceOrderCommand)` decorator,
not a direct reference) → `PlaceOrderService` → `Order.place()` (domain) → `OrderRepository.save()`
(DB) → `OrderEventsProducer.publishOrderPlaced()` (Kafka). If the Kafka publish fails, it's
caught inside `PlaceOrderService` and written to `OrderDeadLetterRepository` instead of failing
the request.

This service is a Kafka **producer only** — it has no consumer of its own. The read side
(a denormalized, query-optimized view of orders) is intentionally a separate future service
that will consume `orders.order-placed` and own its own database, rather than living in this
repo. See `specs/001-place-order/research.md` for the reasoning.

## Endpoints and domain events

| Method | Path | Description |
|---|---|---|
| `POST` | `/orders` | Places a new order. See `specs/001-place-order/contracts/rest-place-order.md`. |

| Event | Topic | Produced/Consumed |
|---|---|---|
| `OrderPlaced` | `orders.order-placed` | Produced by `OrderEventsProducer` after a successful DB save. No consumer in this repo — see `specs/001-place-order/contracts/event-order-placed.md` and `docs/events/order-placed.md`. |
