# Implementation Plan: React to Payment Outcome (US-04)

**Branch**: `feature/US-04-react-to-payment-outcome` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-react-to-payment-outcome/spec.md`

## Summary

Add a Kafka consumer to the Orders service for `payments.payment-processed` and
`payments.payment-failed`. Each message is validated as a DTO, deduplicated by `eventId`, and
mapped to the order named by its `orderId` (never its `aggregateId`, which is the payment id).
A pure domain policy decides whether to confirm, cancel or ignore the message, based on the
order's current status.

Confirm and cancel reuse the existing `ConfirmOrderService` / `CancelOrderService` write flow:
save first, then publish, with dead-letter on publish failure. When a command comes from Kafka, it
also writes a `processed_events` row in the same transaction as a conditional
`WHERE status = 'PENDING'` update.

Offsets are committed manually, only after the outcome is durably saved. Retryable failures use
in-process exponential backoff and are dead-lettered to a new `consumed_message_dead_letters`
table once attempts run out. Malformed messages are dead-lettered immediately. A payment-failure
`reason` is stored on the order and carried as a new optional field on `OrderCancelled`. Design
rationale is in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `kafkajs` 2.2.4 (already a dependency; the
consumer API is used for the first time), TypeORM 0.3, `class-validator` / `class-transformer`.
No new runtime dependencies.

**Storage**: PostgreSQL (orders write DB). One migration adds `orders.cancellationReason`,
`processed_events` and `consumed_message_dead_letters`.

**Testing**: Jest, `@nestjs/testing`, Supertest, testcontainers (`@testcontainers/postgresql`,
`@testcontainers/kafka`, both already present).

**Target Platform**: Linux container (`node:20-alpine`) / local Node against `ecommerce-infra`.

**Project Type**: Web service (NestJS microservice, single project).

**Performance Goals**: An order reaches its final state within 5s of `POST /orders` with both
services running (SC-001). Volume is low (a portfolio-scale platform), so throughput is not a
driver.

**Constraints**: Commit offsets only after the DB save. Exactly one `OrderConfirmed` /
`OrderCancelled` per order. REST endpoints unchanged. HTTP stays available if the consumer cannot
connect. Payment topics are pre-created with 3 partitions, keyed by **payment id** (so there is
no per-order ordering guarantee; see research R4).

**Scale/Scope**: Two consumed topics, one consumer group, one new command handler, two extended
handlers, three new tables or columns, and about 15 new source files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Gate | Status |
|---|---|---|
| I. DDD & layering | Status × outcome rule in the domain (`decidePaymentReaction`) and transitions via `Order.confirm()` / `cancel()`. The consumer is an inbound adapter (I/O, DTO validation, retry/commit mechanics) that only dispatches a command. Services orchestrate only. Repositories persist only. | ✅ |
| II. CQRS | The consumer issues a single command (`ReactToPaymentOutcomeCommand`) and no query. The read model and GraphQL are out of scope (US-05+). No read-path models introduced. | ✅ |
| III. Write flow | Confirm and cancel keep save → publish → outbound dead-letter on publish failure. The inbound path adds the processed record to the **same** transaction as the status change, before publishing. | ✅ |
| IV. Type safety & validation | Inbound messages validated as `class-validator` DTOs (R7). No `any`. `OrderStatus` enum used throughout. Unhandled errors are caught in the consumer, so there is no silent failure (each message ends processed, already processed, or dead-lettered). *Note*: the Kafka path raises internal error classes (`MalformedPaymentMessageError`, `OrderNotFoundForPaymentError`, `OrderStatusChangedConcurrentlyError`) instead of NestJS HTTP exceptions, because there is no HTTP response to map to. They never reach a REST client, and the REST paths keep using NestJS exceptions. | ✅ |
| V. Test coverage | Every new handler, domain function and method has happy-path and error/edge unit tests (R10). The 80% thresholds on `src/domain` and `src/services` stay enforced. | ✅ |
| VI. Testing strategy | Unit + integration (real Postgres) + component (real Kafka and Postgres containers) for the consumer flow. | ✅ |
| VII. Kafka | Consumes the listed topics. Idempotent by `eventId`. Commits only after the DB save. Exponential backoff, then dead-letter. Order resolved by `orderId`, never `aggregateId`. `OrderCancelled.reason` is additive, `version` stays 1. | ✅ |
| VIII. Branching | On `feature/US-04-react-to-payment-outcome`, created from an up-to-date `main` before the spec. Conventional Commits with the `US-04` scope. | ✅ |
| IX. Build & quality | The four-step gate (build, lint, format:check, test) runs after every task. | ✅ (process) |
| Docs standards | JSDoc on new public classes. `docs/events/payment-processed.md` and `payment-failed.md` added; `order-cancelled.md`, `README.md`, `src/README.md` and `CLAUDE.md` updated (FR-020/021). No new ADR needed: the decision is already covered by ADR 0003. | ✅ |

**Post-design re-check (after Phase 1)**: still passes. The data model adds tables only on the
write side (PostgreSQL). Contracts match the constitution's payload rules. No violations, so
Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-react-to-payment-outcome/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: decisions R1–R10
├── data-model.md        # Phase 1: domain, tables, transaction boundary, config
├── quickstart.md        # Phase 1: how to validate end to end
├── contracts/
│   ├── event-payment-processed.md     # consumed
│   ├── event-payment-failed.md        # consumed
│   └── event-order-cancelled-delta.md # produced, additive `reason`
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

New files are marked `+`, changed files `~`.

```text
src/
├── app.module.ts                                  ~ register new entities, repositories, handler, consumer
├── config/configuration.ts                        ~ KafkaConfig: consumerEnabled, retry settings
├── commands/
│   ├── inbound-event-ref.ts                       + InboundEventRef type
│   ├── confirm-order.command.ts                   ~ optional inboundEvent
│   ├── cancel-order.command.ts                    ~ optional { reason, inboundEvent }
│   └── react-to-payment-outcome.command.ts        +
├── domain/
│   ├── order.aggregate.ts                         ~ cancellationReason; cancel(reason?)
│   ├── events/order-cancelled.event.ts            ~ optional reason
│   ├── payment-outcome.enum.ts                    +
│   └── payment-reaction.policy.ts                 + decidePaymentReaction (pure)
├── dto/
│   ├── payment-processed-message.dto.ts           +
│   └── payment-failed-message.dto.ts              +
├── services/
│   ├── confirm-order.service.ts                   ~ transactional inbound path
│   ├── cancel-order.service.ts                    ~ reason + transactional inbound path
│   ├── react-to-payment-outcome.service.ts        + @CommandHandler: dedupe → load → policy → dispatch | record no-op
│   └── errors/payment-outcome.errors.ts           + OrderNotFoundForPaymentError, EventAlreadyProcessedError
├── repositories/
│   ├── order.repository.ts                        ~ map cancellationReason; applyInboundStatusChange (tx + conditional update)
│   ├── processed-event.repository.ts              +
│   ├── consumed-message-dead-letter.repository.ts +
│   └── errors/order-status-changed-concurrently.error.ts +
├── infra/
│   ├── database/
│   │   ├── entities/order.entity.ts               ~ cancellationReason column
│   │   ├── entities/processed-event.entity.ts     +
│   │   ├── entities/consumed-message-dead-letter.entity.ts +
│   │   └── migrations/<ts>-AddPaymentOutcomeConsumerSchema.ts +
│   └── kafka/
│       ├── payment-events.consumer.ts             + subscribe, handleMessage, manual commit, dead-letter
│       ├── payment-message.parser.ts              + JSON → DTO → MalformedPaymentMessageError
│       ├── retry-with-backoff.ts                  + backoff + heartbeat
│       └── order-events.producer.ts               ~ doc comment only ("producer only" wording)
└── README.md                                      ~ consumers now built

tests/
├── unit/
│   ├── domain/order.aggregate.spec.ts             ~ cancel(reason), OrderCancelled.reason
│   ├── domain/payment-reaction.policy.spec.ts     +
│   ├── services/confirm-order.service.spec.ts     ~ inbound path
│   ├── services/cancel-order.service.spec.ts      ~ reason + inbound path
│   ├── services/react-to-payment-outcome.service.spec.ts +
│   └── infra/{payment-message.parser,retry-with-backoff,payment-events.consumer}.spec.ts +
├── integration/react-to-payment-outcome.integration.spec.ts +
└── component/react-to-payment-outcome.component.spec.ts     +

docs/events/payment-processed.md, docs/events/payment-failed.md   +
docs/events/order-cancelled.md, README.md, CLAUDE.md               ~
```

**Structure Decision**: Keep the existing single-project, layer-first layout (`src/README.md`).
The consumer goes under `infra/kafka/` next to the producer, because it is an inbound adapter
like a controller. The new orchestration is a `@CommandHandler` in `services/`, like the existing
three. No new NestJS module: providers are registered in `AppModule`, as today.

## Follow-ups (out of scope, recorded)

- The REST `updateStatus` path is still unconditional (last write wins in a REST-vs-REST race).
  Consider moving it to the conditional update (R4).
- The existing `KafkaModule` awaits `producer.connect()` at bootstrap, so a cold start with Kafka
  down fails. FR-019 is met for the consumer only.
- No transactional outbox: a crash between the DB commit and the publish loses that event
  (unchanged from US-01–03).
- Dead-letter replay jobs are US-08.

## Complexity Tracking

None. No constitution violations to justify.
