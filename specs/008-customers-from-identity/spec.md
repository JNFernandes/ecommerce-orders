# Feature Specification: Create Customers from Identity Registrations (US-10)

**Feature Branch**: `feature/US-10-customers-from-identity`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-10: Create customers from identity.user-registered. Orders
consumes identity.user-registered (see ecommerce-infra/docs/events.md: eventId, aggregateId = user
id, occurredAt, version, customerId, email, name) and creates the customer record that orders refer
to, replacing the manual customer seed." (the full rules, scope and out-of-scope list are
reproduced in the Requirements and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is the Orders service, reacting to "user registered" announcements from the Identity
service. The people who benefit are customers (once they register, they can place orders without
anyone adding them to Orders by hand) and operators/developers (no manual seeding step is needed
outside local development).

This story builds the consumer that constitution v1.3.0 (Principle VII, **Customers**) requires
and that the README and `ecommerce-infra/docs/events.md` list as "planned".

### User Story 1 - A newly registered customer can place orders (Priority: P1)

When Identity announces that a customer account was registered, Orders creates its own customer
record with the announced customer id, name and email. From then on, an order placed for that
customer id is accepted.

**Why this priority**: This is the whole point of the story. Without it, customers who register
through Identity can never place orders, except through the manual seed.

**Independent Test**: Publish a "user registered" message with a new `customerId`; check that a
customer with that id, name and email now exists in Orders, and that placing an order for that
`customerId` succeeds where it returned "unknown customer" before.

**Acceptance Scenarios**:

1. **Given** no customer with id `C`, **When** a valid "user registered" message with
   `customerId` `C`, name `N` and email `E` is processed, **Then** a customer with id `C`, name `N`
   and email `E` exists, and the message is acknowledged after the customer has been saved.
2. **Given** a "user registered" message whose `aggregateId` (user id) differs from its
   `customerId`, **When** it is processed, **Then** the customer is created with the `customerId`
   as its id, and no customer exists with the `aggregateId` as its id.
3. **Given** the customer `C` was created from a "user registered" message, **When** an order is
   placed for `customerId` `C`, **Then** the order is accepted as for any existing customer.
4. **Given** a customer created from a message, **When** the customer is created, **Then** no
   event is published by Orders (creating a customer announces nothing).

---

### User Story 2 - Repeated or overlapping registrations are harmless (Priority: P1)

The same registration can be delivered more than once (redelivery, Identity's own retry worker), and
a customer can already exist (for example the seeded local customer). Neither case creates a
duplicate, changes the existing customer, or is treated as a failure.

**Why this priority**: Delivery is at-least-once by contract. Treating a repeat as an error would
dead-letter valid messages or block the stream.

**Independent Test**: Deliver the same message twice and check one customer exists and the second
delivery is acknowledged with no change. Then deliver a different message (new `eventId`) for a
`customerId` that already exists with other name/email and check the stored customer is unchanged,
the message is acknowledged, and nothing is dead-lettered.

**Acceptance Scenarios**:

1. **Given** a message already processed (same `eventId`), **When** it is delivered again,
   **Then** it is acknowledged with no change.
2. **Given** a customer `C` already exists, **When** a message with a new `eventId` and
   `customerId` `C` arrives (with the same or different name/email), **Then** the stored customer
   is left unchanged, the message is recorded as processed, it is acknowledged, and nothing is
   dead-lettered or logged as an error.
3. **Given** two messages for the same new `customerId` processed at the same time (for example by
   two service instances), **When** both finish, **Then** exactly one customer exists and both
   messages are acknowledged without error.

---

### User Story 3 - Registration messages are processed as reliably as payment and stock messages (Priority: P2)

The registration messages get the same delivery guarantees as the payment and stock messages:
nothing is acknowledged before its result is saved, transient failures are retried with increasing
delays, and a bad message never blocks the ones behind it.

**Why this priority**: The rules are already proven for the other consumers; the new one must not
be a weaker link. It is P2 because it reuses existing mechanisms rather than adding new behaviour.

**Independent Test**: Publish a malformed message followed by a valid one and check the first is
dead-lettered at once and the second is processed. Make the customer save fail temporarily and
check the message is retried, then dead-lettered once retries are exhausted, and that its position
in the stream is not acknowledged before one of these outcomes is saved.

**Acceptance Scenarios**:

1. **Given** a message that is not valid JSON, is not a JSON object, lacks `eventId`, `customerId`
   or `email`, has an `eventId` or `customerId` that is not a UUID, has an empty `email`, or has an
   unsupported `version`, **When** it is received, **Then** it is dead-lettered without retries
   (stored as not retryable), acknowledged, and the next message is processed.
2. **Given** a well-formed message whose customer cannot be saved (for example the database is
   briefly unavailable), **When** it is received, **Then** it is retried with increasing delays and,
   once retries are exhausted, dead-lettered as retryable and the failure logged with full context.
3. **Given** a message dead-lettered as retryable, **When** the dead-letter retry worker (US-08)
   picks it up, **Then** it is processed with the same rules as a live message (including the
   "already exists" rule of Story 2).
4. **Given** any message, **When** its outcome has not been durably saved (as a customer plus
   processed-message record, or as a dead-letter record), **Then** its position in the stream is
   not acknowledged.

---

### User Story 4 - Documentation reflects that customers come from Identity (Priority: P3)

The README explains that customers are created from Identity registrations, that there is a short
delay between registering and being able to order, and that the manual seed command is legacy
tooling for local development.

**Why this priority**: Needed so client developers understand the "unknown customer" response right
after registration, and so nobody relies on the seed outside local development. It changes no
behaviour.

**Independent Test**: Read the README and check it describes the consumer as implemented, the
eventual consistency between registration and the first order (with the client's expected
reaction), and marks the seed command as legacy.

**Acceptance Scenarios**:

1. **Given** the README, **When** a reader looks up how customers are created, **Then** it states
   they come from `identity.user-registered`, keyed by `customerId`, and that the consumer is
   implemented (no longer "planned").
2. **Given** the README, **When** a reader looks up placing an order right after registering,
   **Then** it explains that the order may be rejected as "unknown customer" until Orders has
   processed the registration, and that the client should retry later.
3. **Given** the README, **When** a reader looks up the seed command, **Then** it is marked as
   legacy, for local development only.

---

### Edge Cases

- **User id vs customer id**: `aggregateId` is the Identity user id. It is never stored, used as
  the customer id, or used to look up a customer.
- **Order placed before the registration is processed**: rejected exactly as today for an unknown
  customer (not found, nothing saved, nothing published). It is not queued or retried by Orders.
- **Existing customer with different name or email** (for example the seeded customer, or a later
  re-registration with the same `customerId`): left unchanged. Updates are out of scope.
- **Missing `name`**: the contract always sends one, but it is not one of the fields the story
  makes mandatory; the customer is created without a name rather than dead-lettered.
- **Customers that existed before this story** (seeded rows) have no name or email; they remain
  valid customers for placing orders.
- **Fields beyond the contract** in the message are ignored.
- **Message broker unavailable at startup**: the service starts and its HTTP and GraphQL endpoints
  are available; the new consumer keeps trying to connect in the background, like the existing
  consumers.
- **Database unavailable while processing**: the message is retried, then dead-lettered as
  retryable (Story 3, scenario 2); it is never acknowledged without a saved outcome.

## Requirements *(mandatory)*

### Functional Requirements

**Customer creation**

- **FR-001**: The system MUST consume `identity.user-registered` and, for each valid message whose
  customer does not exist yet, create one customer with the message's `customerId` as its id and
  its `name` and `email` stored with it.
- **FR-002**: The system MUST NEVER use the message's `aggregateId` (the Identity user id) as a
  customer id or to look up a customer.
- **FR-003**: The customer store MUST hold the customer's name and email. Since it holds only the
  id and creation time today, it MUST be extended through a schema migration; customers that
  already exist keep working with no name or email.
- **FR-004**: When a customer with the message's `customerId` already exists, the system MUST
  leave it unchanged (id, name, email, creation time), record the message as processed and
  acknowledge it. This MUST NOT be treated as an error, retried or dead-lettered.
- **FR-005**: The decision "create, or leave the existing customer unchanged" MUST be made outside
  the consumer, through the same command → domain → repository path used for other state changes.
  The consumer only parses the message, dispatches a command and acknowledges.
- **FR-006**: Creating a customer MUST NOT publish any event.

**Delivery guarantees**

- **FR-007**: Each message MUST be deduplicated by `eventId` with the existing processed-message
  mechanism, recorded in the same transaction as the customer creation (or the "already exists"
  no-op).
- **FR-008**: The message's position in the stream MUST be acknowledged only after its outcome has
  been durably saved.
- **FR-009**: A message that is not valid JSON, not a JSON object, lacks `eventId`, `customerId` or
  `email`, has an `eventId` or `customerId` that is not a UUID, has an empty `email`, or has an
  unsupported `version` MUST be dead-lettered immediately to the existing consumed-message
  dead-letter store as not retryable, and acknowledged.
- **FR-010**: A well-formed message whose processing fails MUST be retried with exponential
  backoff (the existing retry settings) and, once retries are exhausted, dead-lettered as
  retryable and the failure logged with the event id, customer id and error.
- **FR-011**: Retryable dead-lettered registration messages MUST be retried by the existing
  dead-letter retry worker (US-08) through the same processing as live messages.
- **FR-012**: The consumer MUST reuse the existing consumer infrastructure (dead-letter wrapper,
  retry with backoff, background connection) and read from its own consumer group; the topic and
  group MUST be configurable alongside the existing ones.

**Startup and existing behaviour**

- **FR-013**: The service MUST start and serve its HTTP and GraphQL endpoints without the message
  broker; the new consumer connects in the background like the existing ones (no change to the
  lazy-connect behaviour).
- **FR-014**: Placing an order for a customer id that does not exist MUST keep its current
  behaviour unchanged (not found, nothing saved, nothing published).
- **FR-015**: The APIs MUST still never create customers.

**Documentation and tooling**

- **FR-016**: The README MUST describe the consumer as implemented, list its configuration, and
  document the eventual consistency between registration and the first order (an early order is
  rejected as "unknown customer"; retry later).
- **FR-017**: The manual seed command MUST keep working for local development and MUST be marked
  as legacy in the README.
- **FR-018**: The consumed message MUST be documented in the service's event documentation,
  consistent with `ecommerce-infra/docs/events.md`; the customer-creation decision MUST be recorded
  as an architecture decision record; the description of the customer record as "read-only" MUST
  be updated now that the consumer writes it.

### Key Entities

- **Customer**: someone who can place orders in Orders. Identified by the customer id announced by
  Identity (not the Identity user id). Holds a name, an email and a creation time. Created once,
  never updated or deleted by this story. Rows created before this story have no name or email.
- **User registered message**: Identity's announcement that a customer account exists. Carries a
  message id (`eventId`), the user id (`aggregateId`, not used), the time it happened, a version,
  and the customer id, email (normalized lowercase) and name.
- **Processed message record** (existing): marks a consumed message as handled, so a redelivery is
  recognised.
- **Consumed-message dead letter** (existing): a message that could not be processed, stored as
  retryable or not retryable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A customer who registers through Identity can place an order in Orders with no
  manual step; with all services running, the order is accepted within 5 seconds of registration.
- **SC-002**: Delivering the same registration any number of times results in exactly one
  customer, with zero errors and zero dead letters.
- **SC-003**: 100% of malformed registration messages are set aside on first receipt and never
  delay the processing of the messages behind them.
- **SC-004**: No registration message is acknowledged without a saved outcome (a customer, a
  no-op record, or a dead letter): stopping the service mid-processing loses no registration.
- **SC-005**: The service starts and answers requests with the message broker down, as before
  this story.
- **SC-006**: Behaviour for orders placed for unknown customers is unchanged: all existing tests
  for that case pass without modification.

## Assumptions

- The contract is `ecommerce-infra/docs/events.md` (`identity.user-registered`): envelope
  (`eventId`, `aggregateId` = user id, `occurredAt`, `version`) plus `customerId` (UUID), `email`
  (normalized) and `name` (1 to 100 characters). Only `version` 1 is supported; other versions are
  dead-lettered as not retryable, like the other consumers.
- `email` is required to be a non-empty string; Identity already normalizes and validates it, so
  Orders does not re-validate its format. `name` is stored when present and is not required.
- Name and email are stored as received; Orders does not use them for any business rule in this
  story (they describe the customer for future use).
- The new consumer uses its own consumer group, configured alongside the existing ones, and the
  existing retry and backoff settings.
- Existing seeded customers keep no name or email; no backfill is done.
- Ordering of registration messages does not matter: each creates at most one independent
  customer.
- **Out of scope**: updating or deleting customers; any change to how orders are authenticated or
  attributed to a customer (US-11); admin users (Identity publishes no event for them); queuing or
  retrying orders placed before the customer exists.
