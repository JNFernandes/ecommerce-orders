# Feature Specification: React to Payment Outcome (US-04)

**Feature Branch**: `feature/US-04-react-to-payment-outcome`

**Created**: 2026-11-11

**Status**: Draft

**Input**: User description: "US-04 React to payment outcome. As the Orders service, I consume the
payment results published by the Payments service so that an order is confirmed when its payment
succeeds and cancelled when it fails, with no manual call." (full description, including
behaviour, scope and acceptance criteria, is reproduced in the Assumptions and Requirements below)

## User Scenarios & Testing *(mandatory)*

The actor is the Orders service itself, reacting to outcomes announced by the Payments service.
The people who benefit are customers (their order reaches a final state without anyone stepping
in) and operators (no manual confirm/cancel calls, and a clear record when something cannot be
processed). This story completes the order/payment saga described in
`docs/adr/0003-saga-by-choreography.md`.

### User Story 1 - Confirm an order when its payment succeeds (Priority: P1)

When Payments announces that the payment for an order succeeded, the Orders service confirms that
order and announces the confirmation, exactly as if an operator had called the existing confirm
endpoint.

**Why this priority**: This is the happy path of the whole purchase flow. Without it, every order
stays `PENDING` until someone confirms it by hand.

**Independent Test**: Place an order, publish a "payment processed" message for that order, and
check that the order becomes `CONFIRMED` and exactly one "order confirmed" announcement is
published.

**Acceptance Scenarios**:

1. **Given** a `PENDING` order, **When** a "payment processed" message referencing that order's id
   arrives, **Then** the order becomes `CONFIRMED` and exactly one `OrderConfirmed` event is
   published after the status change has been saved.
2. **Given** an order that is already `CONFIRMED`, **When** a "payment processed" message for it
   arrives, **Then** nothing changes and no event is published.
3. **Given** an order that is `CANCELLED`, **When** a "payment processed" message for it arrives,
   **Then** the order stays `CANCELLED`, no event is published, and a warning naming the order and
   the payment is logged (any refund is the Payments service's concern).
4. **Given** a "payment processed" message whose payment id differs from its order id, **When** it
   is processed, **Then** the order looked up and confirmed is the one identified by `orderId`,
   never the one identified by `aggregateId`.

---

### User Story 2 - Cancel an order when its payment fails (Priority: P1)

When Payments announces that the payment for an order failed (for example, the amount is over the
payment policy threshold), the Orders service cancels that order, keeps the reason it was given,
and announces the cancellation.

**Why this priority**: Equal to Story 1. Without it, orders whose payment failed would stay
`PENDING` forever and could later be confirmed by mistake.

**Independent Test**: Place an order, publish a "payment failed" message with a reason for that
order, and check that the order becomes `CANCELLED`, the reason is stored with it, and exactly one
"order cancelled" announcement is published.

**Acceptance Scenarios**:

1. **Given** a `PENDING` order, **When** a "payment failed" message referencing it arrives with a
   reason, **Then** the order becomes `CANCELLED`, the failure reason is recorded against the
   order, and exactly one `OrderCancelled` event is published after the change has been saved.
2. **Given** an order that is already `CANCELLED`, **When** a "payment failed" message for it
   arrives, **Then** nothing changes and no event is published.
3. **Given** an order that is `CONFIRMED`, **When** a "payment failed" message for it arrives,
   **Then** the order stays `CONFIRMED`, no event is published, and a warning naming the order and
   the payment is logged.

---

### User Story 3 - Process each payment message exactly once in effect (Priority: P2)

Messages can be delivered more than once (redelivery after a restart, a rebalance, or a manual
replay). Processing the same message again must not change anything or announce anything twice.

**Why this priority**: Without it, a redelivery could publish a second confirmation or
cancellation, and downstream services (Notifications, the future read model) would act twice.

**Independent Test**: Deliver the same "payment processed" (or "payment failed") message twice
and check that the order changes once and only one announcement is published.

**Acceptance Scenarios**:

1. **Given** a payment message that has already been processed, **When** the same message (same
   `eventId`) is delivered again, **Then** it is acknowledged without any change to the order and
   without publishing any event.
2. **Given** a message that was handled as a no-op (for example, the order was already in the
   target state), **When** it is delivered again, **Then** it is recognised as already processed.

---

### User Story 4 - Keep consuming when a message cannot be processed (Priority: P2)

A message that cannot be processed must not block the messages behind it. Temporary problems are
retried; permanent problems are set aside in a dead-letter record for an operator, and processing
carries on.

**Why this priority**: One bad message must not stop every later order from being confirmed or
cancelled.

**Independent Test**: Publish a malformed message followed by a valid one, and check that the
malformed message is dead-lettered immediately and the valid one is still processed. Publish a
message for an order id that does not exist, and check that it is retried and then dead-lettered.

**Acceptance Scenarios**:

1. **Given** a message that is not valid JSON, or lacks `eventId` or `orderId`, **When** it is
   received, **Then** it is dead-lettered without retries, its position is acknowledged, and the
   next message is processed.
2. **Given** a well-formed message whose `orderId` matches no order, **When** it is received,
   **Then** it is retried with increasing delays and, once retries are exhausted, dead-lettered;
   the next message is then processed.
3. **Given** a temporary failure while saving (for example, the database is briefly unavailable),
   **When** a message is being processed, **Then** it is retried with increasing delays and
   succeeds without being dead-lettered if the problem clears before retries run out.
4. **Given** any message, **When** its processing has not been durably saved (as a state change, a
   no-op record or a dead-letter record), **Then** its position in the stream is not acknowledged,
   so it is delivered again after a restart.

---

### Edge Cases

- **Payment id vs order id**: `aggregateId` on a payment message is the payment id. It is never
  used to look up an order, even when no order matches `orderId`.
- **Operator acts first**: an operator confirms or cancels an order through the existing endpoint
  before the payment message arrives. The message then lands on an order that is no longer
  `PENDING` and follows the "already in target state" or "conflicting state" rule (no-op, warning
  if conflicting).
- **Opposite outcomes for the same order**: a "payment processed" followed by a "payment failed"
  for the same order (which Payments says never happens). The first one wins, and the second is
  logged as a conflicting-state warning.
- **Same outcome, different `eventId`**: the order is already in the target state, so it is a no-op
  and no second event is published.
- **Publishing the follow-up event fails** after the order change has been saved: the order keeps
  its new status, the unpublished event goes to the existing outbound dead-letter record (as the
  existing confirm/cancel flow does), and the payment message counts as processed.
- **Unsupported `version`** on a payment message: treated as malformed (dead-lettered, not retried).
- **`orderId` present but not a valid UUID**: treated as malformed.
- **Empty or missing `reason`** on a "payment failed" message: the order is still cancelled, and the
  recorded reason is empty.
- **Messages for different orders** are independent: a message being retried for one order holds
  up only the messages behind it in the same stream partition.
- **The message broker is unavailable at startup**: the HTTP endpoints stay available, and the
  consumer keeps trying to connect and logs each failure.

## Requirements *(mandatory)*

### Functional Requirements

**Subscription**

- **FR-001**: The Orders service MUST subscribe to the `payments.payment-processed` and
  `payments.payment-failed` topics as a single consumer group, whose id is taken from the existing
  `KAFKA_GROUP_ID` configuration.
- **FR-002**: The Orders service MUST identify the target order using the message's `orderId` field
  only. It MUST NOT use the message's `aggregateId` (the payment id) as an order id anywhere.

**Payment processed**

- **FR-003**: On a valid "payment processed" message for a `PENDING` order, the system MUST confirm
  the order through the same confirm business rule and write flow as the existing confirm
  endpoint. The status change is saved first, `OrderConfirmed` is published only after the save
  succeeds, and a publish failure is recorded in the existing outbound dead-letter store.
- **FR-004**: On a "payment processed" message for an order that is already `CONFIRMED`, the system
  MUST make no change and publish nothing.
- **FR-005**: On a "payment processed" message for an order that is `CANCELLED`, the system MUST
  make no change, publish nothing, and log a warning that includes the order id, the payment id and
  the `eventId`.

**Payment failed**

- **FR-006**: On a valid "payment failed" message for a `PENDING` order, the system MUST cancel the
  order through the same cancel business rule and write flow as the existing cancel endpoint,
  record the message's `reason` as the order's cancellation reason, and publish `OrderCancelled`
  only after the save succeeds. A publish failure is recorded in the existing outbound dead-letter
  store.
- **FR-007**: `OrderCancelled` events MUST carry the cancellation reason when there is one, as an
  optional field. Cancellations through the REST endpoint carry no reason. Existing consumers of
  `OrderCancelled` MUST NOT be broken: the change is additive and the event version stays `1`.
- **FR-008**: On a "payment failed" message for an order that is already `CANCELLED`, the system
  MUST make no change and publish nothing.
- **FR-009**: On a "payment failed" message for an order that is `CONFIRMED`, the system MUST make no
  change, publish nothing, and log a warning that includes the order id, the payment id and the
  `eventId`.

**Idempotency and acknowledgement**

- **FR-010**: The system MUST keep a durable record of every processed payment message, keyed by
  its `eventId`. This covers messages that changed an order and messages handled as a no-op.
- **FR-011**: A message whose `eventId` has already been processed MUST be acknowledged without
  changing any order and without publishing any event.
- **FR-012**: For a message that changes an order, the order change and the "processed" record MUST
  be saved together: either both are saved or neither is.
- **FR-013**: The system MUST acknowledge (commit the offset of) a message only after its outcome
  has been durably saved: the state change plus processed record, the no-op processed record, or
  the dead-letter record. A crash before that point MUST lead to redelivery.

**Failure handling**

- **FR-014**: A message is malformed when any of these is true: it is not valid JSON, `eventId` is
  missing or not a UUID, `orderId` is missing or not a UUID, or `version` is not a supported
  version (`1`). A malformed message MUST be dead-lettered immediately without retries, and
  processing MUST continue with the next message.
- **FR-015**: A well-formed message whose `orderId` matches no order, or whose processing fails
  for any other reason, MUST be retried with exponential backoff up to a configured maximum
  number of attempts. Once the attempts are exhausted it MUST be dead-lettered, and processing
  MUST continue.
- **FR-016**: The dead-letter record for a consumed message MUST contain the source topic, the
  partition and offset, the raw message content (even if it is not valid JSON), the `eventId` and
  `orderId` if they could be read, the failure reason, the number of attempts, and when it was
  recorded. It MUST be kept separate from the existing outbound (publish-failure) dead-letter
  records.
- **FR-017**: Retry and dead-letter decisions MUST be logged with the topic, partition, offset,
  `eventId` and `orderId` (when available), and the attempt number.

**Unchanged behaviour**

- **FR-018**: The existing `POST /orders/:orderId/confirm` and `POST /orders/:orderId/cancel`
  endpoints MUST keep their current request, response and error behaviour.
- **FR-019**: The HTTP API MUST remain available while the payment consumer is unable to connect
  to the message broker.

**Documentation**

- **FR-020**: The consumed contracts MUST be documented in `docs/events/payment-processed.md` and
  `docs/events/payment-failed.md`: fields, types, which field identifies the order, the
  idempotency rule, and the outcome for each order status.
- **FR-021**: `docs/events/order-cancelled.md`, the root `README.md`, `src/README.md` and `CLAUDE.md`
  MUST be updated to show that the payment consumers exist (no longer "planned"), and to document
  the optional cancellation reason.

### Key Entities

- **Payment Processed message** (consumed): announces that the payment for an order succeeded.
  Fields: `eventId`, `occurredAt`, `aggregateId` (payment id), `version`, `orderId`, `amount`,
  `currency`, `processedAt`. Published by the Payments service.
- **Payment Failed message** (consumed): announces that the payment for an order failed. Fields:
  `eventId`, `occurredAt`, `aggregateId` (payment id), `version`, `orderId`, `reason`, `failedAt`.
  Published by the Payments service.
- **Order** (existing): gains an optional **cancellation reason**, set only when the order is
  cancelled because its payment failed.
- **Processed Payment Message**: a record that a payment message with a given `eventId` has been
  handled. It stores the `eventId`, the topic, the `orderId`, the outcome (confirmed, cancelled, or
  no-op with the reason) and when it was processed.
- **Consumed-Message Dead Letter**: a message that could not be processed, with the details listed
  in FR-016. It is kept for an operator; retrying it automatically is out of scope (US-08).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With Orders, Payments and the shared infrastructure running, an order placed through
  the public API reaches `CONFIRMED` (payment accepted) or `CANCELLED` (payment over the policy
  threshold) within 5 seconds, with no manual call.
- **SC-002**: For every order that reaches a final state through a payment outcome, exactly one
  confirmation or cancellation announcement is published (0 duplicates).
- **SC-003**: Delivering the same payment message again, any number of times, leaves every order
  and the set of published announcements unchanged.
- **SC-004**: A malformed message does not delay the next valid message by more than the time it
  takes to record it, since it is never retried.
- **SC-005**: Every payment message received ends in exactly one of: processed, recognised as
  already processed, or dead-lettered. None is silently lost.
- **SC-006**: The existing confirm and cancel endpoints pass their existing tests unchanged.

## Assumptions

- **Contract source**: the payment message shapes are those published by the Payments service
  (`ecommerce-payments`, `specs/001-process-payment/contracts/payments.payment-processed.md` and
  `specs/002-handle-payment-failure/contracts/payments.payment-failed.md`). Both carry `orderId`
  as the order reference and `aggregateId` as the payment id, and both are at `version` 1.
- **Payments reads the order id from `OrderPlaced.aggregateId`** (verified in the Payments
  consumer), so the round trip works without changing `OrderPlaced`.
- **Failure reason storage**: "recording the failure reason" means storing it on the order as its
  cancellation reason, and also carrying it as an optional field on `OrderCancelled` so downstream
  services (for example Notifications) can use it. This is an additive, non-breaking change to the
  event.
- **No-op messages are recorded as processed**, so a redelivery is recognised quickly and the
  outcome can be audited.
- **Retry defaults**: up to 5 attempts with exponential backoff starting at about 1 second and
  capped at about 30 seconds. Both values are configurable; the exact numbers belong to planning.
- **Retries happen within the consumer** while it holds the message, so messages behind it in the
  same partition wait. This is acceptable at current volumes, and messages are partitioned per
  order or payment, so other orders are unaffected unless they share the partition.
- **Unknown order ids are retried** as the description requires, even though Orders always saves
  an order before Payments can learn of it. A missing order therefore points to a real problem,
  which is why the message is eventually dead-lettered rather than dropped.
- **Consumer dead letters are stored in PostgreSQL**, in a store separate from the existing
  outbound publish-failure dead letters. Replaying them is out of scope (US-08).
- **Event publishing gap unchanged**: as in the existing write flow, a crash between saving the
  order change and publishing the event can lose that event. This story does not add a
  transactional outbox.
- **Out of scope**: the MongoDB read model and GraphQL (US-05 onwards), dead-letter retry jobs
  (US-08), refunds or any compensation towards Payments, and any change to the Payments service.
- **Tests required** (per the constitution): unit tests for the handling logic (every
  status × outcome combination, duplicate, malformed and unknown-order cases); integration tests
  of the consumer handling against a real PostgreSQL; and a component test with real Kafka and
  PostgreSQL containers that publishes a payment message and asserts the order status and the
  emitted event.
