# Implementation Plan: Confirm an Order Only When Payment Succeeded and Stock Was Reserved (US-09)

**Branch**: `feature/US-09-confirm-on-payment-and-stock` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-confirm-on-payment-and-stock/spec.md`

## Summary

Orders stops confirming on `payments.payment-processed` alone. The `Order` aggregate gains a
payment outcome and a stock outcome, and four methods (`recordPaymentProcessed`,
`recordPaymentFailed`, `recordStockReserved`, `recordStockRejected`) hold every rule: confirm when
both are positive, cancel on the first negative with a `payment failed: …` / `stock rejected: …`
reason, ignore outcomes for non-`PENDING` orders and flag a late payment for refund. Two thin
command handlers (`ApplyPaymentOutcomeService`, `ApplyStockOutcomeService`) run the existing
write flow through a shared helper. A new `InventoryEventsConsumer` consumes
`inventory.stock-reserved` / `inventory.stock-rejected` with the same parse → dispatch → commit,
retry and dead-letter machinery as the payment consumer. One migration adds the two outcome
columns (with backfill) and lets `processed_events` record reservation ids. Concurrent outcomes
are made safe by guarding the write on the outcomes the order was loaded with (research R1).
Read model and GraphQL untouched.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `any` banned), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, TypeORM, `kafkajs`, `class-validator`

**Storage**: PostgreSQL 16 (write side: `orders`, `processed_events`,
`consumed_message_dead_letters`); MongoDB read model unchanged

**Testing**: Jest, Supertest, `@nestjs/testing`, testcontainers (PostgreSQL, Kafka)

**Target Platform**: Linux container / local Node; infra from `ecommerce-infra`

**Project Type**: web service (single NestJS project)

**Performance Goals**: an order reaches its final state within 5 s of the deciding outcome
(SC-001, SC-002); a concurrent-write retry costs one backoff step (~1 s)

**Constraints**: save before publish; offsets committed only after the save; startup never waits
for Kafka; no GraphQL or read-model change; no new event fields

**Scale/Scope**: one new consumer, two topics, two command handlers, one migration; replaces
the US-04 payment reaction

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Constitution v1.2.0.

| Principle | Gate | Status |
|---|---|---|
| I. DDD & layering, order lifecycle | Join rules in `Order` (R2); consumers and services carry none; confirm on both, cancel on either, ignore when not `PENDING` | ✅ |
| II. CQRS separation | Write side only; resolvers, query handlers and `src/read-model/` untouched | ✅ |
| III. Write flow integrity | Save (outcome + processed event, one transaction) → publish → dead-letter on publish failure; first positive outcome publishes nothing | ✅ |
| IV. Type safety & validation | Stock DTOs with `class-validator`; enums for outcomes; no `any` | ✅ |
| V. Test coverage | Unit tests for every new domain method and both handlers (R14) | ✅ |
| VI. Testing strategy | Unit, integration (real PostgreSQL), component (real Kafka + PostgreSQL) | ✅ |
| VII. Kafka events | New consumed topics; `orderId` used, `aggregateId` = reservation id never an order id; dedupe by `eventId`; commit after save; backoff then dead-letter; `consumeWithDeadLetter`; lazy connect via `KafkaConnectLoop`; no payload field change | ✅ |
| VIII. Branching | `feature/US-09-…` from up-to-date `main`; commits `feat(US-09)` / `test(US-09)` / `docs(US-09)` | ✅ |
| IX. Build & quality | Four-step gate after every task | ✅ (enforced during implement) |
| Documentation Standards | JSDoc; `docs/events/stock-*.md` consistent with `ecommerce-infra/docs/events.md`; ADR 0006 updated; differences with the infra file reported (R12) | ✅ |

No violations. **Post-design re-check**: unchanged — the design adds no layer, no new runtime
dependency and no read-path code.

## Project Structure

### Documentation (this feature)

```text
specs/007-confirm-on-payment-and-stock/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R14
├── data-model.md        # Phase 1: aggregate, transition tables, schema
├── quickstart.md        # Phase 1: validation guide
├── contracts/
│   ├── event-stock-reserved.md
│   ├── event-stock-rejected.md
│   └── event-order-cancelled-delta.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── order.aggregate.ts                 # + paymentOutcome, stockOutcome, record*() methods
│   ├── payment-outcome.enum.ts            # + PENDING
│   ├── stock-outcome.enum.ts              # new
│   ├── outcome-application.ts             # new: OutcomeApplication, OutcomeRecord, Attention
│   └── payment-reaction.policy.ts         # removed (US-04 rule)
├── commands/
│   ├── apply-payment-outcome.command.ts   # new (replaces react-to-payment-outcome.command.ts)
│   ├── apply-stock-outcome.command.ts     # new
│   ├── confirm-order.command.ts           # inboundEvent removed (REST only)
│   ├── cancel-order.command.ts            # inboundEvent removed (REST only)
│   └── inbound-event-ref.ts               # paymentId? / reservationId?
├── services/
│   ├── outcome-write-flow.ts              # new: shared dedupe → load → domain → save → publish
│   ├── apply-payment-outcome.service.ts   # new (replaces react-to-payment-outcome.service.ts)
│   ├── apply-stock-outcome.service.ts     # new
│   ├── confirm-order.service.ts           # REST path only
│   ├── cancel-order.service.ts            # REST path only
│   └── errors/payment-outcome.errors.ts   # → outcome.errors.ts (OrderNotFoundForOutcomeError)
├── dto/
│   ├── stock-reserved-message.dto.ts      # new
│   └── stock-rejected-message.dto.ts      # new
├── repositories/
│   ├── order.repository.ts                # applyOutcome() replaces applyInboundStatusChange(); maps outcomes
│   └── processed-event.repository.ts      # writes paymentId or reservationId
├── infra/
│   ├── database/entities/order.entity.ts            # + paymentOutcome, stockOutcome
│   ├── database/entities/processed-event.entity.ts  # + reservationId, new outcome values
│   ├── database/migrations/20261114120000-AddOrderOutcomes.ts  # new
│   ├── kafka/stock-message.parser.ts      # new: topics, MalformedStockMessageError
│   ├── kafka/inventory-events.consumer.ts # new
│   ├── kafka/payment-events.consumer.ts   # dispatches ApplyPaymentOutcomeCommand
│   └── dead-letter/dead-letter-retry.worker.ts  # + inventory consumer as inbound handler
├── config/configuration.ts                # + inventoryGroupId (KAFKA_INVENTORY_GROUP_ID)
└── app.module.ts                          # registers the new handlers, OutcomeWriteFlow and InventoryEventsConsumer

tests/
├── unit/domain/order-outcomes.spec.ts                 # new (R14 matrix)
├── unit/domain/payment-reaction.policy.spec.ts        # removed
├── unit/services/apply-payment-outcome.service.spec.ts, apply-stock-outcome.service.spec.ts
├── unit/infra/stock-message.parser.spec.ts, inventory-events.consumer.spec.ts
├── integration/order-outcomes-migration.integration.spec.ts
├── integration/inventory-events.integration.spec.ts
├── integration/react-to-payment-outcome.integration.spec.ts  # updated for the join (renamed apply-payment-outcome)
├── component/order-outcomes.component.spec.ts
└── component/react-to-payment-outcome.component.spec.ts      # updated for the join

docs/
├── events/stock-reserved.md, stock-rejected.md        # new
├── events/order-cancelled.md, payment-processed.md, payment-failed.md  # updated
├── adr/0006-order-joins-payment-and-stock-outcomes.md # records FR-020 decision
README.md, src/README.md, CLAUDE.md, .env.example      # updated
```

**Structure Decision**: Single NestJS project, existing folders. New files sit next to their
payment counterparts; no new module or base class.

## Key Design Decisions

Full reasoning in [research.md](research.md).

1. **Concurrency (R1)**: write guarded on `status = PENDING` **and** the loaded outcomes;
   `affected = 0` → retryable `OrderStatusChangedConcurrentlyError` → retry reloads.
2. **Domain API (R2)**: `record*()` return an `OutcomeApplication` `{ record, attention }`; the
   domain decides the stored `record`, including ignored and conflicting outcomes (first outcome
   of each side wins); they never throw; `confirm()` / `cancel()` unchanged for REST.
3. **Store outage (spec FR-018)**: retried, then dead-lettered as retryable, like the payment
   consumer; no `isFatal`.
4. **Schema (R5)**: PostgreSQL enums `"paymentOutcome"` / `"stockOutcome"`, default `PENDING`,
   backfill `CONFIRMED` orders. camelCase to match the table (the request said
   `payment_outcome` / `stock_outcome`; see R5). `processed_events` gets `reservationId` and a
   one-of CHECK.
5. **Consumer (R9)**: separate `InventoryEventsConsumer`, own group `KAFKA_INVENTORY_GROUP_ID`,
   built from `consumeWithDeadLetter` + `KafkaConnectLoop` (no `KafkaConsumerBase` exists).
   Topic names are constants next to the parser, like the payment topics.
6. **US-04 code (R7)**: `ReactToPaymentOutcome*` and `decidePaymentReaction` removed; the
   inbound branches of Confirm/Cancel services removed.
7. **ADR (R13)**: the ADR is 0006, not 0004.

## Migration and Rollout Notes

- Breaking for stored data shape only; `down()` restores the previous schema (stock rows in
  `processed_events` are deleted, enum recreated without the two new values).
- Behaviour change visible to other services: `OrderCancelled.reason` gains a prefix;
  `OrderConfirmed` now waits for stock. Without Inventory running, orders stay `PENDING` after
  payment.
- Infra repo follow-up (R12): update the Orders consumer status, the "planned behavior" line and
  the `reason` note in `ecommerce-infra/docs/events.md`.

## Complexity Tracking

No constitution violations to justify.
