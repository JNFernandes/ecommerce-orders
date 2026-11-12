# Feature Specification: Dead-Letter Retry (US-08)

**Feature Branch**: `feature/US-08-dead-letter-retry`

**Created**: 2026-11-12

**Status**: Draft

**Input**: User description: "US-08 Dead-letter retry. As the Orders service, I automatically retry
events that failed to publish to Kafka and messages that failed to be consumed, so that no event is
lost after a temporary outage." (full description, including behaviour, scope and acceptance
criteria, is reflected in the Requirements and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is the Orders service. Today, when publishing an event fails after the order was
saved, or when an inbound message cannot be processed, the problem is recorded in a dead-letter
store and then left there. Payments never hears about the order, the read model misses the
change, or a payment outcome is never applied, until someone intervenes by hand. This story
closes that gap: recorded failures are retried automatically, and the ones that can never succeed
are clearly marked as given up.

### User Story 1 - Unpublished events are published once the broker is back (Priority: P1)

When an event (order placed, confirmed or cancelled) could not be published after the order was
saved, the service keeps retrying it in the background. As soon as the broker is reachable again
the event is published, unchanged, and the record is marked resolved.

**Why this priority**: This is the core risk. An order placed during a broker outage is saved but
never announced, so it is never charged, never confirmed and never shown in the read model. Every
later step of the saga depends on the event getting out.

**Independent Test**: With the broker unavailable (or publishing forced to fail), place an order.
A pending record appears. Make the broker available again: within one or two retry intervals the
event is published with its original event id, and the record is marked resolved.

**Acceptance Scenarios**:

1. **Given** an event failed to publish after its order was saved, **When** it is recorded,
   **Then** the record is pending retry, with zero retries, due immediately.
2. **Given** a pending record and a reachable broker, **When** the retry worker runs, **Then** the
   stored event is published to its original topic, with its original event id and the order id
   as the message key, and the record becomes resolved with the time it was resolved.
3. **Given** the broker is still unreachable, **When** the worker retries, **Then** the record stays
   pending, its retry count goes up by one, the last error and attempt time are stored, and its
   next retry is scheduled later than the previous one.
4. **Given** the full system is running, **When** the broker is stopped, an order is placed, and the
   broker is started again, **Then** the order's event is published within two retry intervals of
   the broker coming back, and downstream processing (payment, confirmation, read model) completes
   as usual.

---

### User Story 2 - Failed inbound messages are processed again (Priority: P1)

Inbound messages that could not be processed (payment outcomes, order events for the read model)
are fed back through the same handling that failed, with the same duplicate protection. A message
that succeeds on a later try is marked resolved, and its effect is applied exactly once.

**Why this priority**: Without it, a payment outcome that failed during an outage leaves an order
stuck in `PENDING`, and a read-model update that failed leaves the view stale for good.

**Independent Test**: Make a payment-outcome message fail (for example, its order did not exist
yet). Once the cause is gone (the order exists), the worker reprocesses it, the order is confirmed
or cancelled exactly once, and the record is resolved. Retrying a message that was already applied
changes nothing and still resolves the record.

**Acceptance Scenarios**:

1. **Given** a pending inbound record for a payment outcome, **When** the worker retries it and
   handling succeeds, **Then** the order changes exactly as if the message had been processed the
   first time, and the record is resolved.
2. **Given** a pending inbound record for an order event, **When** the worker retries it and the
   read model accepts it, **Then** the read model reflects it and the record is resolved.
3. **Given** a pending inbound record whose message had in fact already been applied, **When**
   retried, **Then** nothing changes (duplicate protection) and the record is resolved.
4. **Given** a record of a malformed message (one that can never be processed), **When** it is
   recorded or picked up, **Then** it goes straight to exhausted and is never retried.

---

### User Story 3 - Hopeless failures stop being retried (Priority: P2)

A record that keeps failing is retried with growing delays, up to a cap. After the maximum number
of retries it is marked exhausted, retrying stops, and an error is logged with everything an
operator needs to investigate.

**Why this priority**: Without a limit, a permanently failing record would be retried forever,
creating load and noise. With a limit, the outcome is visible and final.

**Independent Test**: Insert a record that always fails. Advancing time, each retry happens after
a longer delay than the previous one, never beyond the cap. After the maximum number of retries
the record is exhausted, is not picked up again, and an error log names it.

**Acceptance Scenarios**:

1. **Given** a record failing repeatedly, **When** it is retried, **Then** the delay before each
   next attempt grows exponentially from the base delay and never exceeds the maximum delay.
2. **Given** a record that has reached the maximum number of retries, **When** its last retry
   fails, **Then** it becomes exhausted, keeps its last error and attempt time, and is never
   picked up again.
3. **Given** a record becomes exhausted, **When** that happens, **Then** an error is logged with the
   record's identity, its kind (outbound or inbound), topic, event id, order id when known, retry
   count and last error.

---

### User Story 4 - Several instances retry safely together (Priority: P2)

When more than one instance of the service runs, each due record is retried by exactly one of
them at a time. A record is never published or reprocessed twice at once, and none is skipped.

**Why this priority**: Required for running more than one instance. Without it, two instances
would publish the same event twice per cycle, and their bookkeeping would overwrite each other.

**Independent Test**: Run two workers at the same time against the same set of due records. Every
record is processed exactly once in that cycle, and the two workers' sets of processed records do
not overlap.

**Acceptance Scenarios**:

1. **Given** due records and two workers running together, **When** both claim work, **Then** no
   record is claimed by both.
2. **Given** a worker claims records and then stops abruptly before finishing, **When** the claim
   expires, **Then** those records become due again and are retried by a worker. None is lost.

---

### Edge Cases

- **Broker down for a long time**: the outbound record is retried with growing delays and may
  become exhausted after the maximum retries. With the defaults the delays are 5 + 10 + 20 + 40 +
  80 + 160 + 320 s ≈ 10.6 minutes, and because the worker only runs every 30 s, short delays round
  up to the next cycle, so the record gives up after roughly 11–14 minutes. Exhausted records stay
  in the store for an operator. Replaying them by hand is out of scope.
- **Republished event already delivered** (the first publish actually reached the broker but was
  reported as failed): it is delivered again with the same event id. Every consumer deduplicates
  by event id, so this is safe (at-least-once delivery).
- **Out-of-order republishing**: a late `OrderPlaced` published after the order's confirmation is
  handled by the read model's order-independent rules (US-05). Payments receives `OrderPlaced`
  late and proceeds normally.
- **Inbound retry that fails again in a different way** (for example, a read-model outage): it
  counts as a failed attempt and is rescheduled, like any other failure.
- **Retrying an inbound payment outcome whose follow-up event fails to publish**: the payment
  outcome record is resolved (the order was updated), and the unpublished follow-up event becomes
  a new outbound record, retried by this same feature.
- **Existing records at deployment**:
  - outbound records become pending and due immediately;
  - inbound records of malformed messages become exhausted;
  - all other inbound records become pending and due immediately.
- **The worker is still busy when the next interval comes**: cycles never overlap within one
  instance. The next cycle starts only after the previous one has finished.
- **Shutdown during a cycle**: the worker stops taking new records. Records already claimed are
  either finished or released by claim expiry. Shutdown is never blocked for longer than one
  in-flight attempt.
- **Database unavailable**: the cycle fails, is logged, and the next cycle tries again. The rest of
  the service is unaffected.

## Requirements *(mandatory)*

### Functional Requirements

**Record states**

- **FR-001**: Every record in both dead-letter stores MUST have retry bookkeeping:
  - a status: `PENDING_RETRY`, `RESOLVED` or `EXHAUSTED`;
  - a retry count;
  - the time of the next retry;
  - the time and error of the last attempt;
  - the time it was resolved.
- **FR-002**: New outbound records MUST be created as `PENDING_RETRY`, with zero retries and due
  immediately. New inbound records MUST be created as `PENDING_RETRY` the same way, except those of
  malformed messages, which MUST be created as `EXHAUSTED`.
- **FR-003**: A one-time data change MUST give existing records the bookkeeping:
  - existing outbound records become `PENDING_RETRY` and due now;
  - existing inbound records of malformed messages become `EXHAUSTED`;
  - all other existing inbound records become `PENDING_RETRY` and due now.

**Retry worker**

- **FR-004**: A background worker MUST run every `DEAD_LETTER_RETRY_INTERVAL_MS` (default 30000).
  Each cycle picks up to `DEAD_LETTER_BATCH_SIZE` (default 20) due records per store
  (`PENDING_RETRY` and next retry time ≤ now, oldest first) and processes them.
- **FR-005**: Cycles MUST NOT overlap within one instance. The worker MUST NOT delay application
  startup, and MUST stop cleanly on shutdown: no new cycle, and no new records taken once shutdown
  has begun.

**Outbound retry**

- **FR-006**: Retrying an outbound record MUST publish the stored event payload (the same event:
  the same fields, values and event id; key order may differ because the stored JSON does not keep
  it, *clarified in planning, research R4*) to the stored topic, with the event's aggregate id (the order
  id) as the message key. On success the record MUST become `RESOLVED`, with the resolution time.

**Inbound retry**

- **FR-007**: Retrying an inbound record MUST pass the stored raw message through the same parsing
  and handling that originally failed: the payment-outcome handling for `payments.*` topics, and
  the read-model projection for `orders.*` topics. The same duplicate protection applies (payment
  events by event id in the processed-events store; projection by applied event ids on the view).
  On success the record MUST become `RESOLVED`.
- **FR-008**: An inbound record whose message turns out to be malformed when retried MUST become
  `EXHAUSTED` immediately, without consuming further retries.
- **FR-009**: Inbound retries MUST NOT go through the consumers' own in-place retry loop or
  dead-lettering. One worker attempt is one handling attempt, and a failure updates the existing
  record. It never creates a new one.

**Failure handling**

- **FR-010**: On a failed attempt, the record's retry count MUST increase by one, and its last error
  and last attempt time MUST be stored. Its next retry time MUST be
  `now + min(DEAD_LETTER_BASE_DELAY_MS × 2^(retryCount − 1), DEAD_LETTER_MAX_DELAY_MS)` (defaults
  5000 and 600000).
- **FR-011**: When a failed attempt brings the retry count to `DEAD_LETTER_MAX_RETRIES` (default 8),
  the record MUST become `EXHAUSTED`, MUST NOT be retried again, and an error MUST be logged with:
  - the record id;
  - the kind (outbound or inbound);
  - the topic;
  - the event id and order id when known;
  - the retry count and the last error.

**Concurrency**

- **FR-012**: Due records MUST be claimed so that two workers, in the same or different instances,
  never process the same record at the same time. A claim MUST NOT block other workers from
  claiming other due records.
- **FR-013**: A record claimed by a worker that stops abruptly MUST become due again without manual
  action. *(Planning: each record is processed inside the transaction that claims it, so a crash
  rolls back and releases it immediately; no lease is needed. See research R2.)* A record MUST NOT
  be processed twice in the same cycle.

**Delivery guarantees**

- **FR-014**: Delivery MUST be at-least-once. A retry MUST never change an event's id, so
  downstream deduplication by event id keeps republishing safe.

**Configuration and documentation**

- **FR-015**: All settings MUST come from the configuration module and appear in `.env.example`:
  - `DEAD_LETTER_RETRY_INTERVAL_MS`;
  - `DEAD_LETTER_BATCH_SIZE`;
  - `DEAD_LETTER_BASE_DELAY_MS`;
  - `DEAD_LETTER_MAX_DELAY_MS`;
  - `DEAD_LETTER_MAX_RETRIES`;
  - a switch to turn the worker off.
- **FR-016**: `docs/dead-letter-retry.md` MUST describe the two stores, the states and their
  transitions, the backoff schedule, the settings and the multi-instance behaviour. `README.md`,
  `CLAUDE.md`, `docs/read-model.md`, `docs/events/*` and the ADR index MUST be updated where they
  say dead-letter retry is future work.

### Key Entities

- **Outbound dead letter** (existing store, events that failed to publish): event id, topic, the
  full event payload, the original error, and now the retry bookkeeping (FR-001).
- **Inbound dead letter** (existing store, messages that failed to be consumed): source topic,
  partition and offset, the raw message, the event id and order id when known, the failure type
  (malformed or retries exhausted inside the consumer), the in-consumer attempt count, and now the
  retry bookkeeping (FR-001).
- **Retry status**: `PENDING_RETRY` → `RESOLVED` (success) or `EXHAUSTED` (malformed, or the maximum
  retries reached). `RESOLVED` and `EXHAUSTED` are final.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a broker outage, 100% of events that failed to publish during it are published
  within two retry intervals of the broker becoming reachable (as long as they are not yet
  exhausted).
- **SC-002**: 0 events are lost: every failed publish or consumption ends `RESOLVED`, or is visibly
  `EXHAUSTED` with its last error.
- **SC-003**: With two workers running together, 0 records are processed by both in the same cycle.
- **SC-004**: Retry delays for a repeatedly failing record follow the documented schedule (5s,
  10s, 20s, … capped at 10 minutes with the defaults), and the record is exhausted after exactly the
  configured maximum number of retries.
- **SC-005**: Republished and reprocessed events cause 0 duplicate effects downstream (orders
  confirmed or cancelled at most once, read-model views unchanged by duplicates).
- **SC-006**: Application startup time and shutdown time are not measurably affected by the worker
  (startup does not wait for a cycle; shutdown finishes within one in-flight attempt).

## Assumptions

- **Outbound payloads** in the existing store are the complete serialized events (they already
  include `eventId` and `aggregateId`), so republishing does not need the order from the database.
- **"Retries exhausted" inside the consumer ≠ "exhausted" here**: an inbound record created after
  the consumer's own in-place retries ran out (`failureType = RETRIES_EXHAUSTED`) starts as
  `PENDING_RETRY` for this worker. The worker's own exhaustion is the `EXHAUSTED` status. The
  documentation explains both.
- **Existing malformed records** are set to `EXHAUSTED` when the bookkeeping is added, applying the
  "malformed messages are never retried" rule to existing data. The description's "existing rows
  become PENDING_RETRY" therefore applies to every record except malformed ones.
- **Claim release**: *(resolved in planning)* each record is processed inside the transaction
  that locks it, so a crashed worker's lock is released by the rollback and the record is due
  again at once. No lease period is needed.
- **Backoff without jitter**: the description defines a deterministic formula. Spreading between
  instances comes from the claiming, not from jitter.
- **Exhausted and resolved records are kept** (no purge). Cleanup, manual replay, an admin API,
  alerting and dashboards are out of scope.
- **A worker switch** (default on) lets tests and local debugging run without the worker, like the
  existing consumer switch.
- **The read-model outage rule from US-05 still holds**: the projection consumer does not
  dead-letter on a MongoDB outage, so inbound records from the projection are genuine failures
  (or the misclassified case found in US-05 live testing). Retrying them is safe because of
  per-view deduplication.
- **Tests required**:
  - unit tests for the backoff calculation and the retry decisions (resolve, reschedule,
    exhaust, malformed), using fake time;
  - integration tests for claiming against a PostgreSQL container (due-only, batch size,
    oldest-first, two concurrent claimers never overlap, claim expiry);
  - a component test with real Kafka and PostgreSQL containers in which publishing fails first and
    succeeds on a later attempt, plus an inbound retry case.
