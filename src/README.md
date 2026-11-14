# Source Layout

This service is organized by **technical layer first**, not by bounded context — there is
currently one bounded context (orders), so a per-context split would just be indirection.
Files are named by entity/feature (`orders.controller.ts`, `place-order.service.ts`,
`order.repository.ts`) so the layer a file lives in and the thing it's about are both visible
at a glance.

| Folder               | Layer (per the project constitution) | Contents                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controllers/`       | Controller                           | `OrdersController` (REST, write path) and `OrdersResolver` (GraphQL, read path) — I/O only, no business logic. (The Kafka equivalents live in `infra/kafka/`.)                                                                                                                                                                                                                                     |
| `queries/`           | —                                    | CQRS query objects (`ListOrdersQuery`, `GetOrderQuery`), dispatched via `QueryBus`                                                                                                                                                                                                                                                                                                                 |
| `commands/`          | —                                    | CQRS command objects (`PlaceOrderCommand`, `CancelOrderCommand`, `ConfirmOrderCommand`, `ApplyPaymentOutcomeCommand`, `ApplyStockOutcomeCommand`) and `InboundEventRef` (carries a `paymentId` or a `reservationId`, never an order id) — plain data, dispatched via `CommandBus`                                                                                                                                                                                                            |
| `services/`          | Service                              | `PlaceOrderService`, `CancelOrderService`, `ConfirmOrderService` — orchestrate a command: call the domain, then the repository, then Kafka. `ApplyPaymentOutcomeService` / `ApplyStockOutcomeService` — pick the matching `Order.record*()` method and run it through `OutcomeWriteFlow` (dedupe by `eventId`, load by `orderId`, save guarded on the loaded outcomes, then publish; no business rules). Each registered as a CQRS `@CommandHandler`                                                                       |
| `domain/`            | Domain                               | `Order` aggregate (`place()`, `cancel()`, `confirm()`, and the payment/stock join: `recordPaymentProcessed()`, `recordPaymentFailed()`, `recordStockReserved()`, `recordStockRejected()`), `PaymentOutcome` / `StockOutcome` enums, `OutcomeApplication` (`OutcomeRecord` + `Attention`), `OrderItem` value object, `OrderPlaced`/`OrderCancelled`/`OrderConfirmed` events, `OrderValidationError`/`OrderCancellationError`/`OrderConfirmationError` — pure business logic, no I/O, no framework dependency                                                           |
| `dto/`               | —                                    | Request/response shapes validated with `class-validator` (`PlaceOrderDto`) and documented with Swagger; inbound Kafka message DTOs (`PaymentProcessedMessageDto`, `PaymentFailedMessageDto`, `StockReservedMessageDto`, `StockRejectedMessageDto`); `dto/graphql/` — GraphQL types (`Order`, `OrderItem`, `OrdersPage`, `OrderStatus`) built from `OrderView`, and `ListOrdersArgs`                                                                      |
| `graphql/`           | Infrastructure                       | Apollo options (`graphql.config.ts`), the GraphQL error filter, and the schema printer used by `npm run schema:generate`                                                                                                                                                                                                                                                                           |
| `repositories/`      | Repository                           | Thin persistence classes (`OrderRepository`, `CustomerRepository`, `OrderDeadLetterRepository`, `ProcessedEventRepository`, `ConsumedMessageDeadLetterRepository`) — map domain objects to/from TypeORM entities (`processed-event-outcome.mapping.ts` maps the domain `OutcomeRecord` to the stored outcome); the dead-letter ones also claim due rows (`processNextDue`, `FOR UPDATE SKIP LOCKED`)                                                                                            |
| `infra/database/`    | Infrastructure                       | TypeORM entities (`entities/`, including `processed_events` and `consumed_message_dead_letters`), migrations (`migrations/`), a local dev seed script (`seeds/`), and the CLI `DataSource` config                                                                                                                                                                                                  |
| `infra/kafka/`       | Infrastructure                       | `KafkaModule` (client and producer wiring; nothing connects at startup), `KafkaConnectLoop` (background consumer connect with backoff), `OrderEventsProducer`, `PaymentEventsConsumer` (payment events), `InventoryEventsConsumer` (stock events, US-09), `OrderProjectionConsumer` (own order events → read model), the message parsers (`payment-message.parser.ts`, `stock-message.parser.ts`), `consume-with-dead-letter.ts` (shared parse → retry → dead-letter → commit flow), `retry-with-backoff.ts` |
| `infra/dead-letter/` | Infrastructure                       | `DeadLetterRetryWorker` (background retry of both dead-letter tables, US-08) and the pure `retry-policy.ts` (backoff and RESOLVED/EXHAUSTED decision)                                                                                                                                                                                                                                              |
| `read-model/`        | Read side (CQRS)                     | `ReadModelModule` (MongoDB, lazy connection), `OrderProjectionService`, `projectOrderEvent` (pure projection rules), `OrderViewRepository`, the `order_views` schema, read-side types and message DTOs. Imports nothing from the write side                                                                                                                                                        |
| `config/`            | —                                    | Environment configuration loader used by `ConfigModule`                                                                                                                                                                                                                                                                                                                                            |

## Where a request goes

`OrdersController` → `CommandBus` (routes by the `@CommandHandler(PlaceOrderCommand)` decorator,
not a direct reference) → `PlaceOrderService` → `Order.place()` (domain) → `OrderRepository.save()`
(DB) → `OrderEventsProducer.publishOrderPlaced()` (Kafka). If the Kafka publish fails, it's
caught inside `PlaceOrderService` and written to `OrderDeadLetterRepository` instead of failing
the request.

## Where a dead letter goes (US-08)

`DeadLetterRetryWorker` (every `DEAD_LETTER_RETRY_INTERVAL_MS`) → `processNextDue` on each
dead-letter repository (one row per transaction, `FOR UPDATE SKIP LOCKED`) → outbound:
`OrderEventsProducer.republish` (same `eventId`); inbound: the owning consumer's `process()`
(`payments.*` → `PaymentEventsConsumer`, `inventory.*` → `InventoryEventsConsumer`, `orders.*` →
`OrderProjectionConsumer`) →
`decideRetry` (`retry-policy.ts`) → the row is updated to `RESOLVED`, rescheduled or
`EXHAUSTED` in the same transaction. See `docs/dead-letter-retry.md`.

## Where a payment or stock message goes (US-04, US-09)

`PaymentEventsConsumer` / `InventoryEventsConsumer` `.handleMessage` → `parsePaymentMessage` /
`parseStockMessage` (JSON + DTO validation; malformed → `consumed_message_dead_letters`, no
retry) → `CommandBus` → `ApplyPaymentOutcomeService` / `ApplyStockOutcomeService` →
`OutcomeWriteFlow` (skip if `eventId` is in `processed_events`; load the order by **`orderId`**,
never `aggregateId`) → `Order.record*()` (domain: confirm when both outcomes are positive, cancel
on the first negative, ignore otherwise) → `OrderRepository.applyOutcome` saves the order change
and the `processed_events` row in one transaction, guarded on the order still being `PENDING`
with the outcomes it was loaded with (an ignored outcome only writes the `processed_events` row)
→ then publish `OrderConfirmed` / `OrderCancelled`, dead-lettering a failed publish. Failures
(including a lost race on the guard) are retried with exponential backoff and then
dead-lettered. The offset is committed only after the outcome is saved.

## Where a GraphQL query goes (US-06)

`POST /graphql` → `OrdersResolver.orders` (args validated by the global `ValidationPipe`; errors
mapped by `GraphQLUserInputFilter`) → `QueryBus` → `ListOrdersService` (`@QueryHandler`) →
`OrderViewRepository.list()` (MongoDB `order_views`, index-backed) → mapped to GraphQL types with
`OrderType.fromView`. `OrdersResolver.order` (US-07) follows the same path with `GetOrderQuery` →
`GetOrderService` → `OrderViewRepository.findById()` (by `_id`, id lower-cased), returning the
order or `null`. No command, no PostgreSQL.

## Where an order event goes (US-05)

`OrderProjectionConsumer.handleMessage` (group `KAFKA_PROJECTION_GROUP_ID`) →
`parseOrderEventMessage` (malformed → `consumed_message_dead_letters`) → `OrderProjectionService` →
`OrderViewRepository.findById` → `projectOrderEvent` (duplicate → no write) →
`insert` / `replace` at the read `revision` (MongoDB `order_views`) → commit offset. A MongoDB
outage is retried and then redelivered rather than dead-lettered. Details in
[docs/read-model.md](../docs/read-model.md).

## Endpoints and domain events

| Method | Path                       | Description                                                                                                                                                                                              |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/orders`                  | Places a new order. See `specs/001-place-order/contracts/rest-place-order.md`.                                                                                                                           |
| `POST` | `/orders/:orderId/cancel`  | Cancels a `PENDING` order (`404` if not found, `409` if not `PENDING`). See `docs/us-02-cancel-order.md`.                                                                                                |
| `POST` | `/orders/:orderId/confirm` | Confirms a `PENDING` order manually (`404` if not found, `409` if not `PENDING`). Payment-driven confirmation happens automatically via `payments.payment-processed`. See `docs/us-03-confirm-order.md`. |

| Event              | Topic                        | Produced/Consumed                                                                                                                                                                                                                           |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrderPlaced`      | `orders.order-placed`        | Produced by `OrderEventsProducer` after a successful DB save. Also consumed by the read-model projection (`OrderProjectionConsumer`) — see `specs/001-place-order/contracts/event-order-placed.md` and `docs/events/order-placed.md`.       |
| `OrderCancelled`   | `orders.order-cancelled`     | Produced by `OrderEventsProducer` after a successful status-update save (REST cancel, payment failure or stock rejection; optional `reason`: `payment failed: …` / `stock rejected: …`). Also consumed by the read-model projection (`OrderProjectionConsumer`) — see `docs/events/order-cancelled.md`. |
| `OrderConfirmed`   | `orders.order-confirmed`     | Produced by `OrderEventsProducer` after a successful status-update save (REST confirm, or payment processed **and** stock reserved). Also consumed by the read-model projection (`OrderProjectionConsumer`) — see `docs/events/order-confirmed.md`.                                                     |
| `PaymentProcessed` | `payments.payment-processed` | **Consumed** by `PaymentEventsConsumer`: records the payment on the order referenced by `orderId` and confirms it once the stock is also reserved. Produced by `ecommerce-payments`. See `docs/events/payment-processed.md`.                                                                              |
| `PaymentFailed`    | `payments.payment-failed`    | **Consumed** by `PaymentEventsConsumer`: cancels the order referenced by `orderId` and stores the reason. Produced by `ecommerce-payments`. See `docs/events/payment-failed.md`.                                                            |
| `StockReserved`    | `inventory.stock-reserved`   | **Consumed** by `InventoryEventsConsumer`: records the stock on the order referenced by `orderId` (never `aggregateId`, the reservation id) and confirms it once the payment is also processed. Produced by `ecommerce-inventory`. See `docs/events/stock-reserved.md`. |
| `StockRejected`    | `inventory.stock-rejected`   | **Consumed** by `InventoryEventsConsumer`: cancels the order referenced by `orderId` with `stock rejected: <reason>`. Produced by `ecommerce-inventory`. See `docs/events/stock-rejected.md`. |
