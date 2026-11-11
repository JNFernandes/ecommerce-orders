# Source Layout

This service is organized by **technical layer first**, not by bounded context — there is
currently one bounded context (orders), so a per-context split would just be indirection.
Files are named by entity/feature (`orders.controller.ts`, `place-order.service.ts`,
`order.repository.ts`) so the layer a file lives in and the thing it's about are both visible
at a glance.

| Folder | Layer (per the project constitution) | Contents |
|---|---|---|
| `controllers/` | Controller | `OrdersController` — HTTP I/O only, no business logic. (The Kafka equivalent, `PaymentEventsConsumer`, lives in `infra/kafka/`.) |
| `commands/` | — | CQRS command objects (`PlaceOrderCommand`, `CancelOrderCommand`, `ConfirmOrderCommand`, `ReactToPaymentOutcomeCommand`) and `InboundEventRef` — plain data, dispatched via `CommandBus` |
| `services/` | Service | `PlaceOrderService`, `CancelOrderService`, `ConfirmOrderService` — orchestrate a command: call the domain, then the repository, then Kafka. `ReactToPaymentOutcomeService` — dedupes a payment event, asks the domain policy, then dispatches Confirm/Cancel or records a no-op. Each registered as a CQRS `@CommandHandler` |
| `domain/` | Domain | `Order` aggregate (`place()`, `cancel()`, `confirm()`), `OrderItem` value object, `OrderPlaced`/`OrderCancelled`/`OrderConfirmed` events, `OrderValidationError`/`OrderCancellationError`/`OrderConfirmationError`, `decidePaymentReaction` (order status × payment outcome rule) — pure business logic, no I/O, no framework dependency |
| `dto/` | — | Request/response shapes validated with `class-validator` (`PlaceOrderDto`) and documented with Swagger; inbound Kafka message DTOs (`PaymentProcessedMessageDto`, `PaymentFailedMessageDto`) |
| `repositories/` | Repository | Thin persistence classes (`OrderRepository`, `CustomerRepository`, `OrderDeadLetterRepository`, `ProcessedEventRepository`, `ConsumedMessageDeadLetterRepository`) — map domain objects to/from TypeORM entities |
| `infra/database/` | Infrastructure | TypeORM entities (`entities/`, including `processed_events` and `consumed_message_dead_letters`), migrations (`migrations/`), a local dev seed script (`seeds/`), and the CLI `DataSource` config |
| `infra/kafka/` | Infrastructure | `KafkaModule` (client and producer wiring), `OrderEventsProducer`, `PaymentEventsConsumer` (inbound adapter for payment events), `payment-message.parser.ts`, `retry-with-backoff.ts` |
| `config/` | — | Environment configuration loader used by `ConfigModule` |

## Where a request goes

`OrdersController` → `CommandBus` (routes by the `@CommandHandler(PlaceOrderCommand)` decorator,
not a direct reference) → `PlaceOrderService` → `Order.place()` (domain) → `OrderRepository.save()`
(DB) → `OrderEventsProducer.publishOrderPlaced()` (Kafka). If the Kafka publish fails, it's
caught inside `PlaceOrderService` and written to `OrderDeadLetterRepository` instead of failing
the request.

## Where a payment message goes (US-04)

`PaymentEventsConsumer.handleMessage` → `parsePaymentMessage` (JSON + DTO validation; malformed →
`consumed_message_dead_letters`, no retry) → `CommandBus` → `ReactToPaymentOutcomeService` (skip if
`eventId` is in `processed_events`; load the order by **`orderId`**, never `aggregateId`) →
`decidePaymentReaction` (domain) → `ConfirmOrderCommand` / `CancelOrderCommand` with the inbound
event, or a no-op record. The Confirm/Cancel services save the status change and the
`processed_events` row in one transaction (conditional on the order still being `PENDING`), then
publish. Failures are retried with exponential backoff and then dead-lettered. The offset is
committed only after the outcome is saved.

## Read model (planned, not yet built)

Per [ADR 0001](../docs/adr/0001-cqrs-read-model-in-orders-service.md), a projection will consume
this service's own `orders.*` events and build a **MongoDB read model** for GraphQL queries
(US-05 onwards). Query handlers will read only from that model, and its schemas will not reuse
the TypeORM entities. There is no GraphQL resolver or MongoDB connection in `src/` yet.

## Endpoints and domain events

| Method | Path | Description |
|---|---|---|
| `POST` | `/orders` | Places a new order. See `specs/001-place-order/contracts/rest-place-order.md`. |
| `POST` | `/orders/:orderId/cancel` | Cancels a `PENDING` order (`404` if not found, `409` if not `PENDING`). See `docs/us-02-cancel-order.md`. |
| `POST` | `/orders/:orderId/confirm` | Confirms a `PENDING` order manually (`404` if not found, `409` if not `PENDING`). Payment-driven confirmation happens automatically via `payments.payment-processed`. See `docs/us-03-confirm-order.md`. |

| Event | Topic | Produced/Consumed |
|---|---|---|
| `OrderPlaced` | `orders.order-placed` | Produced by `OrderEventsProducer` after a successful DB save. Will also be consumed by the planned read-model projection — see `specs/001-place-order/contracts/event-order-placed.md` and `docs/events/order-placed.md`. |
| `OrderCancelled` | `orders.order-cancelled` | Produced by `OrderEventsProducer` after a successful status-update save (REST cancel or payment failure; optional `reason`). Will also be consumed by the planned read-model projection — see `docs/events/order-cancelled.md`. |
| `OrderConfirmed` | `orders.order-confirmed` | Produced by `OrderEventsProducer` after a successful status-update save. Will also be consumed by the planned read-model projection — see `docs/events/order-confirmed.md`. |
| `PaymentProcessed` | `payments.payment-processed` | **Consumed** by `PaymentEventsConsumer`: confirms the order referenced by `orderId`. Produced by `ecommerce-payments`. See `docs/events/payment-processed.md`. |
| `PaymentFailed` | `payments.payment-failed` | **Consumed** by `PaymentEventsConsumer`: cancels the order referenced by `orderId` and stores the reason. Produced by `ecommerce-payments`. See `docs/events/payment-failed.md`. |
