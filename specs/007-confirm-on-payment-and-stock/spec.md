# Feature Specification: Confirm an Order Only When Payment Succeeded and Stock Was Reserved (US-09)

**Feature Branch**: `feature/US-09-confirm-on-payment-and-stock`

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "US-09: Confirm an order only when payment succeeded AND stock was
reserved. Today Orders confirms an order as soon as payments.payment-processed arrives. With the
Inventory service in the saga, Orders must wait for both outcomes (see
ecommerce-infra/docs/events.md)." (the full rules, scope and out-of-scope list are reproduced in
the Requirements and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is the Orders service, reacting to outcomes announced by two other services: Payments
(was the order paid for?) and Inventory (could its items be reserved?). The people who benefit are
customers (an order is only confirmed when it can actually be delivered, and they learn quickly
when it cannot) and operators (no order is confirmed without stock, and late payments that need a
refund are flagged).

This story implements the order lifecycle of constitution v1.2.0 (Principle I) and
`docs/adr/0006-order-joins-payment-and-stock-outcomes.md`. It replaces the US-04 rule "confirm as
soon as the payment is processed".

### User Story 1 - Confirm an order once both outcomes are positive (Priority: P1)

A placed order waits for two outcomes. When the payment has been processed **and** the stock has
been reserved, whichever arrived first, the order is confirmed and the confirmation is announced.
One positive outcome alone leaves the order pending.

**Why this priority**: This is the happy path of the purchase flow and the core change of the
story. Without it, orders are confirmed even when their items are out of stock.

**Independent Test**: Place an order, publish "payment processed" and check the order is still
`PENDING` with no announcement; publish "stock reserved" and check the order becomes `CONFIRMED`
with exactly one "order confirmed" announcement. Repeat with the two messages in the opposite order.

**Acceptance Scenarios**:

1. **Given** a `PENDING` order with both outcomes pending, **When** "payment processed" arrives,
   **Then** the payment outcome is recorded as processed, the order stays `PENDING`, and no event
   is published.
2. **Given** a `PENDING` order with both outcomes pending, **When** "stock reserved" arrives,
   **Then** the stock outcome is recorded as reserved, the order stays `PENDING`, and no event is
   published.
3. **Given** a `PENDING` order whose payment is processed, **When** "stock reserved" arrives,
   **Then** the order becomes `CONFIRMED` and exactly one `OrderConfirmed` event is published after
   the change has been saved.
4. **Given** a `PENDING` order whose stock is reserved, **When** "payment processed" arrives,
   **Then** the order becomes `CONFIRMED` and exactly one `OrderConfirmed` event is published after
   the change has been saved.
5. **Given** a "stock reserved" message whose reservation id differs from its order id, **When** it
   is processed, **Then** the order looked up is the one identified by `orderId`, never the one
   identified by `aggregateId`.

---

### User Story 2 - Cancel an order as soon as either outcome is negative (Priority: P1)

When the payment fails **or** the stock is rejected, the order is cancelled immediately, without
waiting for the other outcome, and the cancellation is announced with a reason that says which side
failed and why.

**Why this priority**: Equal to Story 1. A rejected stock reservation must stop the order (and,
through the cancellation announcement, trigger the refund and the release of anything already
held). Payment-failure cancellation from US-04 must keep working.

**Independent Test**: Place an order, publish "stock rejected" with reason `insufficient stock`,
and check the order becomes `CANCELLED` with reason `stock rejected: insufficient stock` and exactly
one "order cancelled" announcement carrying that reason. Repeat with "payment failed".

**Acceptance Scenarios**:

1. **Given** a `PENDING` order (any combination of pending/positive outcomes), **When** "payment
   failed" arrives with reason `R`, **Then** the payment outcome is recorded as failed, the order
   becomes `CANCELLED` with cancellation reason `payment failed: R`, and exactly one
   `OrderCancelled` event carrying that reason is published after the change has been saved.
2. **Given** a `PENDING` order (any combination of pending/positive outcomes), **When** "stock
   rejected" arrives with reason `R`, **Then** the stock outcome is recorded as rejected, the order
   becomes `CANCELLED` with cancellation reason `stock rejected: R`, and exactly one
   `OrderCancelled` event carrying that reason is published after the change has been saved.
3. **Given** a `PENDING` order whose payment is already processed, **When** "stock rejected"
   arrives, **Then** the order is cancelled as in scenario 2 (the processed payment is refunded by
   Payments when it reads the cancellation; that is not this service's concern).

---

### User Story 3 - Ignore outcomes for orders that are no longer pending (Priority: P1)

Outcomes can arrive after the order has already reached a final state: the second outcome after a
cancellation, or a duplicate outcome with a new message id. These must never change the order or
announce anything. A payment that succeeds for an order already cancelled is flagged, because that
customer was charged and needs a refund.

**Why this priority**: With two independent outcomes, "the other outcome arrives after the order
was cancelled" is a normal, frequent case, not an anomaly. Mishandling it would reopen or
double-announce orders.

**Independent Test**: Cancel an order through "payment failed", then publish "stock reserved" and
"payment processed" for it; check the order stays `CANCELLED`, nothing is published, an
informational log is written for the stock outcome and a warning for the payment.

**Acceptance Scenarios**:

1. **Given** a `CANCELLED` order, **When** "payment processed" arrives, **Then** nothing changes, no
   event is published, and a **warning** naming the order and the payment says the payment needs a
   refund.
2. **Given** a `CANCELLED` order, **When** "stock reserved", "stock rejected" or "payment failed"
   arrives, **Then** nothing changes, no event is published, and an informational log line names
   the order, the outcome and the order's status.
3. **Given** a `CONFIRMED` order, **When** "payment processed" or "stock reserved" arrives (a
   duplicate outcome under a new message id), **Then** nothing changes, no event is published, and
   an informational log line is written.
4. **Given** a `CONFIRMED` order, **When** "payment failed" or "stock rejected" arrives, **Then**
   nothing changes, no event is published, and a warning names the order and the conflicting
   outcome (the order was confirmed on outcomes that are now contradicted).
5. **Given** a `PENDING` order whose payment is already processed, **When** a second "payment
   processed" with a different message id arrives, **Then** nothing changes and no event is
   published (likewise for a second "stock reserved").
6. **Given** a `PENDING` order whose payment is already processed (stock still pending),
   **When** "payment failed" arrives, **Then** nothing changes, no event is published, and a
   warning names the order and the conflicting outcome; the first payment outcome wins. Likewise
   for "stock rejected" after "stock reserved".
7. **Given** any ignored outcome, **When** it is handled, **Then** it is still recorded as
   processed, so a redelivery of the same message is recognised.

---

### User Story 4 - Process stock messages as reliably as payment messages (Priority: P2)

The stock messages get the same delivery guarantees as the payment messages from US-04:
processed exactly once in effect, a bad message never blocks the ones behind it, and nothing is
acknowledged before its result is saved.

**Why this priority**: The rules are already proven for payments; the new messages must not be a
weaker link. It is P2 because it reuses existing mechanisms rather than adding new behaviour.

**Independent Test**: Deliver the same "stock reserved" message twice and check the order changes
once. Publish a malformed stock message followed by a valid one and check the first is
dead-lettered at once and the second is processed. Publish a stock message for an unknown order
id and check it is retried and then dead-lettered.

**Acceptance Scenarios**:

1. **Given** a stock message already processed, **When** the same message (same `eventId`) is
   delivered again, **Then** it is acknowledged with no change and no event.
2. **Given** a stock message that is not valid JSON, lacks `eventId` or `orderId`, has an `orderId`
   that is not a UUID, or has an unsupported `version`, **When** it is received, **Then** it is
   dead-lettered without retries (stored as not retryable), acknowledged, and the next message is
   processed.
3. **Given** a well-formed stock message whose `orderId` matches no order, **When** it is
   received, **Then** it is retried with increasing delays and, once retries are exhausted,
   dead-lettered as retryable, exactly like an unknown order in US-04.
4. **Given** a stock message dead-lettered as retryable, **When** the dead-letter retry worker
   (US-08) picks it up and the order now exists, **Then** it is processed with the same rules as a
   live message.
5. **Given** any stock message, **When** its outcome has not been durably saved (as a state
   change, an ignored-outcome record or a dead-letter record), **Then** its position in the stream
   is not acknowledged.

---

### User Story 5 - Existing orders keep a consistent state after the upgrade (Priority: P3)

Orders created before this story have no recorded outcomes. After the upgrade, confirmed orders
show both outcomes as positive, and every other order shows both as pending.

**Why this priority**: Needed so the stored data does not contradict the new rule (a confirmed
order without positive outcomes), but it only touches a development database.

**Independent Test**: Apply the upgrade to a database containing `PENDING`, `CONFIRMED` and
`CANCELLED` orders and check the recorded outcomes of each.

**Acceptance Scenarios**:

1. **Given** an existing `CONFIRMED` order, **When** the upgrade is applied, **Then** its payment
   outcome is processed and its stock outcome is reserved.
2. **Given** an existing `PENDING` or `CANCELLED` order, **When** the upgrade is applied, **Then**
   both its outcomes are pending.
3. **Given** a new order placed after the upgrade, **When** it is saved, **Then** both its outcomes
   are pending.

---

### Edge Cases

- **Reservation id vs order id**: `aggregateId` on a stock message is the reservation id. It is
  never used to look up an order, even when no order matches `orderId`.
- **Both outcomes processed at the same time**: the payment and stock messages for one order travel
  on different topics, with different message keys (payment id, reservation id), so they can be
  handled concurrently, even by different service instances. The result MUST be the same as if
  they had been handled one after the other: exactly one confirmation when both are positive, never
  an order left `PENDING` with both outcomes positive, and never both a confirmation and a
  cancellation.
- **Opposite outcomes on the same side** (payment processed then payment failed, or stock
  reserved then stock rejected), which Payments and Inventory say never happens: the first
  outcome of that side wins, and the second is ignored with a conflict warning (Story 3,
  scenario 6), as in US-04.
- **Both outcomes negative**: the first negative outcome cancels the order with its reason; the
  second is ignored (Story 3, scenario 2). The recorded reason is that of the first.
- **Negative then positive on the other side** (payment failed, then stock reserved): the order
  stays `CANCELLED`; Inventory releases the stock when it reads the cancellation.
- **Stock rejected, then payment processed**: the order stays `CANCELLED`, a refund warning is
  logged (Story 3, scenario 1), and Payments refunds when it reads the cancellation.
- **Operator acts first**: an order cancelled through `POST /orders/:orderId/cancel` is no longer
  `PENDING`, so later outcomes follow Story 3. The same holds after a manual confirmation through
  `POST /orders/:orderId/confirm`, which stays an operator override that does not wait for the
  outcomes (FR-020).
- **Empty or missing failure reason** on "payment failed" or "stock rejected": the order is still
  cancelled, and the reason is just `payment failed` or `stock rejected` (no trailing colon).
- **Publishing the follow-up event fails** after the change has been saved: the order keeps its new
  status, the event goes to the existing outbound dead-letter store and is republished later
  (US-08), and the inbound message counts as processed.
- **Recording a first positive outcome fails to save** (for example the database is briefly down):
  the message is retried like any other failed save and is not acknowledged until it succeeds.
- **The message broker is unavailable at startup**: the HTTP endpoints stay available, and the new
  consumer keeps trying to connect in the background, like the existing consumers.
- **An order that never receives one of its outcomes** stays `PENDING` indefinitely. Timing it out
  is out of scope.

## Requirements *(mandatory)*

### Functional Requirements

**Order outcomes and lifecycle (domain)**

- **FR-001**: Every order MUST track a payment outcome (`PENDING`, `PROCESSED`, `FAILED`) and a
  stock outcome (`PENDING`, `RESERVED`, `REJECTED`). A newly placed order MUST start with both
  outcomes `PENDING`.
- **FR-002**: Recording a positive outcome on a `PENDING` order MUST confirm the order when the
  other outcome is already positive, and otherwise leave it `PENDING` with the outcome recorded.
- **FR-003**: Recording a negative outcome on a `PENDING` order MUST cancel the order immediately,
  whatever the other outcome is, with cancellation reason `payment failed: <reason>` or
  `stock rejected: <reason>` (`payment failed` / `stock rejected` when the reason is empty or
  missing).
- **FR-004**: An outcome for an order that is not `PENDING`, a repeat of an outcome already
  recorded on a `PENDING` order, or an outcome that contradicts the one already recorded for the
  same side of a `PENDING` order (payment failed after payment processed, stock rejected after
  stock reserved) MUST change nothing and publish nothing. The first outcome of each side wins.
- **FR-005**: Each ignored outcome MUST be logged with the order id, the outcome, the order status
  and the inbound message id: at **warning** level for "payment processed" on a `CANCELLED` order
  (the payment needs a refund), for a negative outcome on a `CONFIRMED` order, and for an outcome
  that contradicts the recorded one on a `PENDING` order; at informational level otherwise.
- **FR-006**: The decision of FR-002 to FR-005 MUST be made by the `Order` domain model (methods
  that record a payment outcome and a stock outcome), not by consumers or application services.
  The US-04 rule that confirms on "payment processed" alone MUST be removed.

**Write flow**

- **FR-007**: Every outcome-driven change MUST be saved before any event is published. A
  confirmation MUST publish exactly one `OrderConfirmed`; a cancellation MUST publish exactly one
  `OrderCancelled` carrying the cancellation reason. Recording a first positive outcome MUST publish
  nothing.
- **FR-008**: If publishing fails after the save, the system MUST log it, store the event in the
  existing outbound dead-letter store, and still treat the inbound message as processed.
- **FR-009**: Concurrent outcomes for the same order MUST produce the same result as if they had
  been processed one after the other (see Edge Cases), including across service instances.

**Stock consumer**

- **FR-010**: The Orders service MUST consume `inventory.stock-reserved` and
  `inventory.stock-rejected`, as defined in `ecommerce-infra/docs/events.md`.
- **FR-011**: The target order MUST be identified by the message's `orderId`. The message's
  `aggregateId` (the reservation id) MUST NOT be used as an order id.
- **FR-012**: The stock consumer MUST only parse and validate the message, check it has not been
  processed, and hand it to the application layer, exactly like the existing payment consumer. It
  MUST contain no business logic.
- **FR-013**: Stock messages MUST be deduplicated by `eventId`, using the same processed-message
  record as payment messages, written in the same transaction as the resulting order change or
  ignored-outcome record.
- **FR-014**: A stock message's position MUST be acknowledged only after its outcome (state change,
  ignored-outcome record or dead-letter record) has been saved.
- **FR-015**: A stock message is malformed when it is not valid JSON, `eventId` or `orderId` is
  missing or not a UUID, or `version` is not a supported version. Malformed messages MUST be
  dead-lettered immediately, as not retryable, without retries.
- **FR-016**: A well-formed stock message whose `orderId` matches no order, or whose processing
  fails, MUST be retried with exponential backoff and then dead-lettered as retryable in the
  existing consumed-message dead-letter store, with the same settings and logging as payment
  messages.
- **FR-017**: Dead-lettered stock messages MUST be retryable by the existing dead-letter retry
  worker (US-08), going through the stock consumer's own processing path.
- **FR-018**: A temporary outage of the database the stock consumer writes to MUST be handled
  exactly like the payment consumer: retried with exponential backoff and, if it outlasts the
  retries, dead-lettered as retryable and acknowledged, so the dead-letter retry worker (US-08)
  replays it once the database is back. (Only the read-model projection treats a store outage as
  fatal; that does not change.)
- **FR-019**: The stock consumer MUST start in the background and never delay or block service
  startup, and MUST be switched off by the existing setting that disables the consumers.

**Existing behaviour**

- **FR-020**: The existing `POST /orders/:orderId/confirm` endpoint MUST stay an operator
  override: it confirms any `PENDING` order whatever its recorded outcomes, leaves those outcomes
  unchanged, and keeps its current responses (`200`, `404`, `409` when not `PENDING`). Outcomes
  arriving afterwards follow FR-004 and FR-005 (a negative one logs the conflict warning).
- **FR-021**: The existing `POST /orders/:orderId/cancel` endpoint MUST keep its behaviour: it
  cancels a `PENDING` order without a reason and leaves the recorded outcomes unchanged.
- **FR-022**: Payment-failure cancellation MUST keep working end to end; the only visible change is
  the `payment failed: ` prefix on the reason.
- **FR-023**: The read model and the GraphQL API MUST NOT change. They keep reflecting the order
  status through the existing events; the recorded outcomes are not exposed.

**Data upgrade**

- **FR-024**: A database migration MUST add the two outcomes to stored orders, defaulting to
  `PENDING`. Existing `CONFIRMED` orders MUST be set to payment `PROCESSED` and stock `RESERVED`;
  all other existing orders keep both `PENDING`. The migration MUST be reversible.

**Documentation**

- **FR-025**: The consumed contracts MUST be documented in `docs/events/stock-reserved.md` and
  `docs/events/stock-rejected.md`, consistent with `ecommerce-infra/docs/events.md`.
  `docs/events/order-cancelled.md` (reason values), `docs/events/payment-processed.md` (no longer
  confirms on its own), the root `README.md`, `src/README.md` and `CLAUDE.md` MUST be updated, and
  the "Planned" stock rows in the README MUST become "Built". ADR 0006 MUST record the FR-020
  decision (manual confirm kept as an operator override) in place of its open follow-up.

### Key Entities

- **Order**: the aggregate. Gains a **payment outcome** and a **stock outcome**. Its status
  (`PENDING`, `CONFIRMED`, `CANCELLED`) is now derived from those outcomes by the rules above, plus
  the existing operator actions. Keeps its cancellation reason.
- **Payment outcome**: `PENDING` (nothing heard yet), `PROCESSED`, `FAILED`.
- **Stock outcome**: `PENDING`, `RESERVED`, `REJECTED`.
- **Stock message** (inbound): `eventId`, `occurredAt`, `aggregateId` (reservation id), `version`,
  `orderId`, plus for "stock rejected" a `reason` and the failed items. Only `eventId`, `orderId`,
  `version` and (for rejections) `reason` are used; the item lists are informational.
- **Processed-message record** (existing): one per handled inbound message, by `eventId`, now also
  for stock messages.
- **Consumed-message dead letter** (existing): now also holds stock messages.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With Orders, Payments, Inventory and the shared infrastructure running, an order
  whose payment succeeds and whose stock is reserved reaches `CONFIRMED` within 5 seconds of the
  later of the two outcomes, with no manual step.
- **SC-002**: An order whose stock is rejected, or whose payment fails, reaches `CANCELLED` within
  5 seconds of that outcome, with a reason that names the failing side.
- **SC-003**: For each of the 4 outcome kinds taken pairwise, in both arrival orders, and for each
  starting status, the resulting status and announcements match the rules; 0 orders are confirmed
  with a negative or missing outcome.
- **SC-004**: For every order that reaches a final state through outcomes, exactly one
  announcement is published, including when the two outcomes are processed at the same time.
- **SC-005**: Delivering any stock or payment message again, any number of times, leaves every
  order and the set of announcements unchanged.
- **SC-006**: Every stock message received ends in exactly one of: processed, recognised as a
  duplicate, ignored with a log line, or dead-lettered; none is acknowledged without one of these
  being saved.
- **SC-007**: Every late "payment processed" for a cancelled order produces exactly one warning
  that an operator can search for.
- **SC-008**: The GraphQL schema and read-model tests pass unchanged.

## Assumptions

- **Contract source**: the stock message shapes are those in `ecommerce-infra/docs/events.md`
  (published by `ecommerce-inventory`, `version` 1). `inventory.stock-rejected.reason` is one of
  `insufficient stock`, `unknown product`, `unknown product and insufficient stock`, so a stock
  cancellation reason reads for example `stock rejected: insufficient stock`.
- **Reason prefix for payments**: "existing behaviour keeps working" means the order is still
  cancelled and the reason still carried on the event and stored; the stored and announced reason
  now has the `payment failed: ` prefix. Existing tests that assert the bare reason are updated.
- **Conflict warnings kept**: US-04 warned when a "payment failed" arrived for a `CONFIRMED` order.
  That warning is kept and extended to "stock rejected", because a contradiction of a confirmed
  order is an anomaly an operator should see. Only the late-payment-after-cancellation warning is
  new.
- **Manual confirmation is an operator override** (clarified 2026-11-14): it is the one way to
  confirm an order without both positive outcomes, it is only reachable by an operator, and
  keeping it means no REST or US-03 change. ADR 0006 is updated to record this decision (FR-025).
- **Ignored outcomes are not recorded on the order**: once an order is final, its outcomes are left
  as they were when it became final. The inbound message is still recorded as processed.
- **No new announcement for a first positive outcome**: other services do not need to know that one
  side succeeded; the read model is unchanged (FR-023).
- **Retry and dead-letter settings are shared** with the payment consumer (the existing
  `PAYMENT_CONSUMER_*` settings); whether the stock topics share the payment consumer's group or get
  their own is a planning decision.
- **Backfill on a development database**: existing `PENDING` orders are not special-cased, as the
  description says; any outcome they later receive is handled by the new rules.
- **Platform docs**: `ecommerce-infra/docs/events.md` lists the Orders consumers of the stock
  topics as "planned" and says Orders confirms on payment alone until the Inventory stories land.
  Updating it is a change in the `ecommerce-infra` repo, outside this story's branch, and is
  flagged as a follow-up.
- **Out of scope**: refunding a late payment (a Payments story), a timeout for orders that never
  receive an outcome, any change to the GraphQL schema or the read model, and any change to the
  Payments or Inventory services.
- **Tests required** (per the constitution): unit tests for the `Order` outcome methods covering
  every arrival order of the four outcomes from each starting status, plus repeats, empty reasons
  and conflicts; unit tests for the application service and the stock message parser; integration
  tests of the stock consumer against a real PostgreSQL (happy paths, duplicate, malformed,
  unknown order, concurrent outcomes) and of the migration backfill; and a component test with real
  Kafka and PostgreSQL that publishes a payment and a stock message in both orders and asserts the
  final status and the published events.
