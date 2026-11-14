# 0006. Orders joins the payment and stock outcomes

- **Status**: Accepted
- **Date**: 2026-11-14

## Context

[ADR 0003](0003-saga-by-choreography.md) set up the order saga by choreography with a single
decision point: Orders confirms on `PaymentProcessed` and cancels on `PaymentFailed`.

Inventory now takes part in the saga. It consumes `OrderPlaced`, tries to reserve every item
atomically, and publishes `inventory.stock-reserved` or `inventory.stock-rejected`
(contract in `ecommerce-infra/docs/events.md`). Payments and Inventory react to the same
`OrderPlaced` independently, so:

- the two outcomes can reach Orders in any order, and either can be redelivered;
- confirming on payment alone would confirm orders whose stock cannot be delivered;
- the compensations already exist: on `OrderCancelled`, Payments refunds a processed payment and
  Inventory releases a reserved stock, and both ignore the event when there is nothing to undo.

Inventory events, like payment events, carry the order id in `orderId`. Their `aggregateId` is
the reservation id.

## Decision

We will keep the saga choreographed and make **Orders the join point** of the two outcomes:

1. Orders consumes `payments.payment-processed`, `payments.payment-failed`,
   `inventory.stock-reserved` and `inventory.stock-rejected`, and identifies the order by
   `orderId`, never by `aggregateId`.
2. The `Order` aggregate (or a pure domain policy) records each outcome and decides:
   - **both** payment processed **and** stock reserved → `CONFIRMED`, publish `OrderConfirmed`;
   - payment failed **or** stock rejected → `CANCELLED` at once, publish `OrderCancelled` with
     the reason, without waiting for the other outcome;
   - one success so far → stay `PENDING`, record it, publish nothing;
   - any outcome for an order that is no longer `PENDING` → ignore it and log it.
3. The consumers stay inbound adapters: parse a DTO, dispatch a command, commit. They follow the
   existing consumer rules (dedupe by `eventId` in the same transaction as the state change,
   commit offsets only after the PostgreSQL save, backoff, dead-letter).

We rejected introducing an orchestrator: the flow is still two parallel steps and one join, and
the compensations are already triggered by `OrderCancelled`.

## Consequences

- An order is confirmed only when it can be both paid for and delivered.
- The `Order` aggregate gains state for the pending outcomes (payment, stock), which needs a
  schema migration. The join is pure domain logic and is unit-testable for every arrival order.
- A late success after a cancellation (for example stock reserved after the payment failed) is
  ignored by Orders. Inventory releases that stock when it consumes `OrderCancelled`, so nothing
  stays held.
- An order stays `PENDING` while either outcome is missing; a lost or dead-lettered event leaves
  it stuck. The stuck-order timeout noted in ADR 0003 becomes more important.
- Existing code must change: today Orders confirms on `PaymentProcessed` alone, and
  `POST /orders/:orderId/confirm` confirms manually, bypassing the join. The story that adds the
  stock consumer has to rework the payment reaction and decide the fate of the manual endpoint.
