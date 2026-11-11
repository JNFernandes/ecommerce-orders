# Feature Specification: Order Read Model Projection (US-05)

**Feature Branch**: `feature/US-05-order-read-model-projection`

**Created**: 2026-11-11

**Status**: Draft

**Input**: User description: "US-05 Order read model projection. As the Orders service, I project my
own order events into a MongoDB read model so that the read path (GraphQL, built in later stories)
can query orders without touching the PostgreSQL write model." (full description, including
behaviour, scope and acceptance criteria, is reflected in the Requirements and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is the Orders service. It keeps a query-friendly copy of every order (the "order view")
up to date by listening to the events it already publishes. Nobody reads the view yet: GraphQL
queries come in US-06 and US-07. This story makes sure the view exists, is correct, and stays
correct when events arrive late, twice, or out of order. It implements the read side described in
[ADR 0001](../../docs/adr/0001-cqrs-read-model-in-orders-service.md) and Constitution Principle II.

### User Story 1 - Every new order appears in the read model and follows its lifecycle (Priority: P1)

When an order is placed, a view of it appears with status `PENDING`, its customer, items and
total. When the order is later confirmed or cancelled (by the payment outcome or by an operator),
the view shows the new status and when it happened. A cancellation also shows its reason, if one
was given.

**Why this priority**: This is the whole point of the story. Without it, the later GraphQL stories
have nothing to query.

**Independent Test**: Place an order and wait for its payment outcome. Check that the order's view
first appears as `PENDING` with the right customer, items and total, and then shows `CONFIRMED`
(or `CANCELLED` with the reason) with the matching timestamp.

**Acceptance Scenarios**:

1. **Given** no view exists for an order, **When** its "order placed" event is projected, **Then**
   a view exists with status `PENDING`, the customer, every item (product, quantity, unit price,
   subtotal), the total, and `placedAt` equal to the event's time.
2. **Given** a `PENDING` view, **When** the order's "order confirmed" event is projected, **Then**
   the status becomes `CONFIRMED` and `confirmedAt` equals the event's time.
3. **Given** a `PENDING` view, **When** the order's "order cancelled" event is projected, **Then**
   the status becomes `CANCELLED`, `cancelledAt` equals the event's time, and
   `cancellationReason` is set if the event carries a reason (otherwise it is null).
4. **Given** the service, Payments and the shared infrastructure are running, **When** an order is
   placed through the public API, **Then** its view appears as `PENDING` within 5 seconds and shows
   the payment outcome (`CONFIRMED` or `CANCELLED`) within 5 seconds of that outcome.

---

### User Story 2 - Late and out-of-order events still produce the right view (Priority: P1)

The three kinds of order events travel on separate streams, so the confirmation or cancellation
of an order can be projected before its "order placed" event. The view must end up the same
whichever order they arrive in.

**Why this priority**: Without it, a perfectly normal delivery order could leave a confirmed
order looking `PENDING`, or a view missing its items. Correctness of the read model depends on it.

**Independent Test**: Project "order confirmed" first and "order placed" second for the same
order. The final view must equal the view produced when they arrive in the normal order.

**Acceptance Scenarios**:

1. **Given** no view exists, **When** an "order confirmed" (or "order cancelled") event is
   projected first, **Then** a view is created with that terminal status and its timestamp, and
   the customer id from the event. Items and total are not known yet.
2. **Given** a view created by an early "order confirmed" or "order cancelled" event, **When** the
   "order placed" event arrives, **Then** items, total and `placedAt` are filled in, and the status
   stays `CONFIRMED` or `CANCELLED`.
3. **Given** a view with status `CONFIRMED` or `CANCELLED`, **When** an "order placed" event for
   it is projected, **Then** the status is never set back to `PENDING`.
4. **Given** any arrival order of the same set of events for an order, **When** all of them have
   been projected, **Then** the resulting view is identical.

---

### User Story 3 - Replays and duplicates change nothing (Priority: P2)

Events can be delivered more than once, and an operator can rebuild the whole read model by
replaying the event history from the beginning. Doing so must give exactly the same views.

**Why this priority**: Replay is how the read model is rebuilt or backfilled. If replay is not
safe, the read model cannot be trusted or repaired.

**Independent Test**: Project an order's events, then project the same events again. Separately,
reset the projection to the beginning of the history and replay everything. Compare the views
before and after: they must be identical.

**Acceptance Scenarios**:

1. **Given** a view to which an event has already been applied, **When** the same event (same
   `eventId`) is projected again, **Then** the view is unchanged.
2. **Given** a complete read model, **When** the projection is reset to the start of the event
   history and everything is replayed, **Then** every view is identical to before, field by field,
   including `updatedAt`.
3. **Given** orders placed before this feature was deployed whose events are still in the event
   history, **When** the projection starts for the first time, **Then** a view is created for each
   of them (backfill).

---

### User Story 4 - Keep projecting when an event cannot be applied (Priority: P2)

An event that cannot be applied must not stop the views of all later orders from being updated.
Temporary problems (for example, the read-model store briefly unavailable) are retried.
Permanent problems are set aside for an operator, and projecting carries on.

**Why this priority**: One bad event must not freeze the read model for every other order.

**Independent Test**: Publish a malformed order event followed by a valid one. The malformed one
is set aside immediately and the valid one is still projected. Make the read-model store
unavailable briefly: the event is retried and applied once the store is back.

**Acceptance Scenarios**:

1. **Given** an order event that is not valid JSON, or lacks its event id, order id or required
   fields, **When** it is received, **Then** it is recorded in the existing consumed-message
   dead-letter store (with its topic and the error) without retries, and the next event is
   projected.
2. **Given** a temporary failure writing the view, **When** an event is being projected, **Then** it
   is retried with increasing delays and applied once the failure clears. If the read-model store
   stays unreachable, the event is not dead-lettered: it is redelivered after the store recovers.
3. **Given** a failure that persists through every retry, **When** the retries are exhausted,
   **Then** the event is recorded in the dead-letter store with its topic and the error, and the
   next event is projected.
4. **Given** any event, **When** its outcome (view written, or dead-letter recorded) has not been
   saved, **Then** its position in the stream is not acknowledged, so it is delivered again.

---

### Edge Cases

- **Confirmed and cancelled both received for one order**: the write side never allows this (a
  status changes from `PENDING` only once). If it happens anyway, the view keeps the terminal
  event that **occurred first** (earlier `occurredAt`, with `eventId` as tie-breaker). That keeps
  the result the same whatever the arrival order. The other event is recorded as applied, its
  timestamp is ignored, and a warning is logged.
- **Cancellation without a reason** (REST cancellations): `cancellationReason` is null, not an
  empty string. A cancellation whose reason is an empty string (payment failed
  without a reason) stores `""`.
- **"Order confirmed" or "order cancelled" for an order whose "order placed" never arrives** (for
  example, it is still in the outbound dead-letter table): the view exists with its terminal
  status, its customer and no items. It is completed if the "order placed" event ever arrives.
- **Same `eventId` arriving on two different topics**: treated as already applied to that view.
  Event ids are unique, so this only happens on redelivery.
- **Events older than the event history's retention**: these cannot be replayed, so orders older
  than that window are not backfilled (see Assumptions).
- **Payment outcome consumer and projection running together**: they are independent consumers. A
  failure or backlog in one does not delay or block the other.
- **The read-model store is unavailable at startup**: the HTTP API and the payment outcome
  consumer keep working, and the projection keeps retrying its connection.

## Requirements *(mandatory)*

### Functional Requirements

**Subscription**

- **FR-001**: The Orders service MUST run a projection consumer that subscribes to
  `orders.order-placed`, `orders.order-confirmed` and `orders.order-cancelled`, in its own consumer
  group. The group id comes from a new setting, `KAFKA_PROJECTION_GROUP_ID` (default
  `ecommerce-orders-projection`), and MUST be separate from the payment outcome consumer group.
- **FR-002**: The projection consumer group MUST start from the earliest available event the first
  time it runs, so existing orders still in the event history are backfilled.

**Read model**

- **FR-003**: The read model MUST hold one view per order in the `order_views` collection of the
  read-model database (configured by a new setting, `MONGO_URI`), identified by the order id.
- **FR-004**: Each view MUST contain: `orderId`, `customerId`, `status` (`PENDING`, `CONFIRMED` or
  `CANCELLED`, using the same values as the write model's order status), `items` (each with
  `productId`, `quantity`, `unitPrice`, `subtotal`), `totalAmount`, `placedAt`, `confirmedAt`,
  `cancelledAt`, `cancellationReason` (only when the cancellation carried one), and `updatedAt`.
  Every field is always present; a field whose value is not known yet is null, so all views have
  the same shape.
- **FR-005**: Item `subtotal` MUST equal `quantity × unitPrice`, rounded to 2 decimal places. The
  "order placed" event carries quantity and unit price but no subtotal.
- **FR-006**: `placedAt`, `confirmedAt` and `cancelledAt` MUST be the `occurredAt` of the event that
  set them. `updatedAt` MUST be the latest `occurredAt` among the events applied to the view, not
  the time of projection, so a replay reproduces it exactly.

**Projection rules**

- **FR-007**: "Order placed" MUST create the view with status `PENDING`, or, if the view already
  exists, fill in `customerId`, `items`, `totalAmount` and `placedAt` **without changing a
  `CONFIRMED` or `CANCELLED` status**.
- **FR-008**: "Order confirmed" MUST set status `CONFIRMED` and `confirmedAt`, creating the view
  (with `customerId`) if it does not exist.
- **FR-009**: "Order cancelled" MUST set status `CANCELLED` and `cancelledAt`, and
  `cancellationReason` when the event carries one, creating the view (with `customerId`) if it
  does not exist.
- **FR-010**: If both terminal events are applied to one view, the one with the earlier
  `occurredAt` MUST determine the status and its timestamp (ties broken by the smaller
  `eventId`), and a warning MUST be logged.
- **FR-011**: The final view for an order MUST be the same for every arrival order of its events.

**Idempotency and acknowledgement**

- **FR-012**: Each view MUST record the `eventId`s already applied to it. An event whose `eventId`
  is already recorded on its view MUST be acknowledged without changing the view.
- **FR-013**: Applying an event and recording its `eventId` MUST happen in a single atomic write
  to the view.
- **FR-014**: The projection MUST acknowledge (commit the offset of) an event only after its view
  write, or its dead-letter record, has been durably saved.
- **FR-015**: Resetting the projection consumer group to the earliest offset and replaying MUST
  produce views identical to the existing ones.

**Failure handling**

- **FR-016**: An event is malformed when any of these is true: it is not valid JSON; `eventId` or
  `aggregateId` is missing or not a UUID; `occurredAt` is missing or not a timestamp; `version` is
  not `1`; or, for "order placed", `customerId`, `items` (with `productId`, a positive integer
  `quantity` and a non-negative `unitPrice`) or `totalAmount` is missing or invalid. A malformed
  event MUST be dead-lettered immediately without retries, and projecting MUST continue.
- **FR-017**: Any other failure MUST be retried with exponential backoff up to the configured
  maximum number of attempts, then dead-lettered, and projecting MUST continue. **Exception**: when
  the read-model store itself is unreachable (an outage, not a bad event), the event MUST NOT be
  dead-lettered. Its offset stays uncommitted and it is redelivered once the store is back, so an
  outage never leaves holes in the read model. *(Added during planning; see plan research R6.)*
- **FR-018**: Dead letters MUST go to the existing consumed-message dead-letter store (the one used
  by the payment outcome consumer), recording at least the topic, partition, offset, raw message,
  event id and order id when readable, the error, and the number of attempts.

**Separation from the write side**

- **FR-019**: Read-model types MUST be defined separately from the write model's persistence
  entities and domain aggregate. No class is shared between the two paths.
- **FR-020**: The projection MUST NOT write to the write-model database, apart from dead-letter
  records. It MUST NOT read the write-model database to build views.
- **FR-021**: A failure or outage of the read-model store MUST NOT affect the HTTP API, the payment
  outcome consumer, or the write path.

**Configuration and documentation**

- **FR-022**: `MONGO_URI` and `KAFKA_PROJECTION_GROUP_ID` MUST be added to `.env.example`, with the
  local development value
  `mongodb://mongo_user:mongo_pass@localhost:27017/orders_read?authSource=admin` and
  `ecommerce-orders-projection` respectively.
- **FR-023**: `docs/read-model.md` MUST describe the view's shape, each projection rule (including
  out-of-order, duplicate and conflicting events), the backfill and rebuild procedure, and its
  limits. `README.md`, `CLAUDE.md`, `src/README.md`, the event docs and the ADR index MUST be
  updated where they describe the read model as planned.

### Key Entities

- **Order View**: the read-model representation of one order, identified by the order id. It holds
  the customer, items with subtotals, total, status, the three lifecycle timestamps, the
  cancellation reason (optional), `updatedAt`, and the list of applied event ids. It is
  eventually consistent with the write model and derived entirely from order events.
- **Order Item View**: a line inside an Order View: product id, quantity, unit price, subtotal.
- **Order events** (consumed, produced by this same service): "order placed" (customer, items,
  total), "order confirmed" (customer), "order cancelled" (customer, optional reason). Contracts
  are in `docs/events/`.
- **Consumed-Message Dead Letter** (existing, from US-04): reused for events the projection cannot
  apply.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the full system running, a newly placed order is visible in the read model
  within 5 seconds, and its final status is visible within 5 seconds of the payment outcome.
- **SC-002**: After a full replay of the event history, 100% of views are identical to the views
  before the replay.
- **SC-003**: For every order whose events are all in the event history, the read model's status,
  items and total match the write model's (0 mismatches after the projection has caught up).
- **SC-004**: Delivering any event a second time changes 0 views.
- **SC-005**: A malformed event delays the next valid event by no more than the time it takes to
  record it, since it is never retried.
- **SC-006**: Every consumed order event ends in exactly one of: applied, recognised as already
  applied, or dead-lettered. None is silently lost.

## Assumptions

- **Event contracts** are the existing ones in `docs/events/` (`order-placed.md`,
  `order-confirmed.md`, `order-cancelled.md`), at `version` 1. `aggregateId` is the order id for
  all three, unlike payment events. No event contract changes in this story.
- **Backfill is limited by the event history's retention.** The shared Kafka keeps order topics
  for 7 days (`retention.ms = 604800000`, delete policy). Orders whose events are older than that
  cannot be backfilled by replay. Today every local order is still within the window (5 orders,
  5 "order placed" events). A rebuild-from-write-model job, or longer or compacted retention, is a
  possible follow-up and is out of scope here.
- **Orders whose "order placed" event failed to publish** (sitting in the outbound
  `order_dead_letters` table) do not appear in the read model until that event is republished
  (US-08).
- **Applied event ids are stored on the view**, which makes the dedupe check and the update a
  single atomic write. An order receives at most 2 events today (placed plus one terminal), so
  the list stays tiny.
- **Retry and dead-letter behaviour reuses US-04's settings and mechanism**: the same backoff
  settings (`PAYMENT_CONSUMER_MAX_ATTEMPTS`, `PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`,
  `PAYMENT_CONSUMER_BACKOFF_MAX_MS`) and the same `consumed_message_dead_letters` table. Whether
  to rename or split these settings is left to planning.
- **`KAFKA_CONSUMER_ENABLED`** (from US-04) also controls the projection consumer, so the HTTP API
  can run alone. Planning may split this into separate switches.
- **Out of scope**: the GraphQL schema, queries and resolvers (US-06, US-07); any endpoint that
  reads the model; dead-letter retry jobs (US-08); a rebuild-from-PostgreSQL tool; indexes for
  future query patterns (added with the queries that need them).
- **Tests required** (per the constitution and the description):
  - unit tests for the projection rules, including out-of-order, duplicate and conflicting
    terminal events;
  - integration tests for the read-model repository against a real MongoDB container;
  - a component test with real Kafka, PostgreSQL and MongoDB containers, covering an order placed
    and then confirmed, end to end into `order_views`.
