# 0003. Order/payment saga by choreography

- **Status**: Accepted
- **Date**: 2026-11-11

## Context

Placing an order involves two services that own separate databases: Orders and Payments. A
distributed transaction across them is not an option, so the order's final state (`CONFIRMED` or
`CANCELLED`) has to be reached through a saga: a sequence of local transactions linked by events.

A saga can be **orchestrated** (a central coordinator tells each service what to do) or
**choreographed** (each service reacts to the events of the others). The flow here is short and
linear, with a single decision point (did the payment succeed?).

## Decision

We will implement the saga by **choreography**, with no central orchestrator:

1. Orders saves a `PENDING` order and publishes `OrderPlaced` (`orders.order-placed`).
2. Payments consumes `OrderPlaced`, attempts the charge, and publishes either
   `PaymentProcessed` (`payments.payment-processed`) or `PaymentFailed`
   (`payments.payment-failed`).
3. Orders consumes those events and confirms or cancels the order, then publishes
   `OrderConfirmed` or `OrderCancelled`.

Payment events reference the order through their `orderId` field. Their `aggregateId` is the
payment id and is never used to look up an order.

## Consequences

- There is no coordinator to build, deploy or keep available, and each service only knows the
  events it consumes.
- The overall flow is implicit: it is spread across services and documented in `docs/events/`
  and in this ADR rather than in one place in the code. If the saga gains more steps or
  compensations, we should reconsider orchestration in a new ADR.
- Every consumer must be idempotent (dedupe by `eventId`), commit offsets only after its DB save,
  retry with exponential backoff and then dead-letter, because events can be redelivered.
- An order can stay `PENDING` if a payment event is lost or dead-lettered. Detecting stuck orders
  (for example a timeout that cancels them) is follow-up work.
