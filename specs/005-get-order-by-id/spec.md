# Feature Specification: Get Order by Id over GraphQL (US-07)

**Feature Branch**: `feature/US-07-get-order-by-id`

**Created**: 2026-11-12

**Status**: Draft

**Input**: User description: "US-07 Get order by id (GraphQL). As an API consumer, I query a single
order by its id over GraphQL so that I can see its current state from the read model." (full
description, including behaviour, scope and acceptance criteria, is reflected in the Requirements
and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is an **API consumer**: a front end showing an order page, a support tool, or another
service checking an order after placing it. It already knows the order id (returned by
`POST /orders`) and wants that one order's current state, read from the read model (US-05) through
the GraphQL API introduced in US-06.

### User Story 1 - Look up an order by its id (Priority: P1)

The consumer asks for one order by id and gets that order, with the same fields as in the order
list: status, customer, items, total and lifecycle timestamps.

**Why this priority**: It is the whole story. "Show me order X" is the most common read after
placing an order.

**Independent Test**: Place an order through the REST API, then query it by the returned id. The
response shows that order with status `PENDING`, its items and its total. Once the payment
outcome has been processed, the same query shows `CONFIRMED` or `CANCELLED` (with the reason).

**Acceptance Scenarios**:

1. **Given** an order exists in the read model, **When** the consumer queries it by id, **Then** the
   response contains exactly that order with all its fields (same shape and values as the list).
2. **Given** an order whose payment succeeded, **When** queried by id, **Then** it shows `CONFIRMED`
   and its confirmation time.
3. **Given** an order whose payment failed, **When** queried by id, **Then** it shows `CANCELLED`,
   its cancellation time and the failure reason.
4. **Given** the service, Payments and the shared infrastructure are running, **When** an order is
   placed through the public API and then queried by its id, **Then** it is returned within 5
   seconds, and its final status within 5 seconds of the payment outcome.

---

### User Story 2 - "Not found" is an answer, not an error (Priority: P1)

Asking for an id that matches no order returns an empty answer (`null`) with no error, so
consumers can treat "no such order (yet)" as a normal outcome.

**Why this priority**: It is required by the description. Treating "nothing found" as a failure
would make every client handle errors for a normal case, including the moment just after an
order is placed and before it is projected.

**Independent Test**: Query a well-formed id that was never used. The response contains `null`
for the order and no errors entry.

**Acceptance Scenarios**:

1. **Given** no order with that id exists, **When** queried with a valid UUID, **Then** the result
   is `null` and the response has no `errors`.
2. **Given** an order that was just placed but not yet projected, **When** queried by its id,
   **Then** the result is `null`. Once projected, the same query returns the order. The query's
   description in the schema says that this can happen.

---

### User Story 3 - Clear error for a malformed id (Priority: P2)

An id that is not a valid UUID is rejected with a clear error that names the argument, and the
service keeps working for everyone else.

**Why this priority**: It tells a caller's bug (a malformed id) apart from "not found". It is not
needed for the main flow.

**Independent Test**: Query with id `"abc"`. The response has one error, marked as bad user input,
saying the order id must be a UUID, and no data. A valid query sent right after succeeds.

**Acceptance Scenarios**:

1. **Given** an id that is not a UUID, **When** queried, **Then** the response is a GraphQL error
   with code `BAD_USER_INPUT` and a message naming `orderId`.
2. **Given** the id argument is missing, **When** queried, **Then** GraphQL rejects the query as
   invalid, because the argument is required.
3. **Given** any invalid request, **When** the next valid query arrives, **Then** it succeeds.

---

### Edge Cases

- **Order known only from its confirmation or cancellation** (projected before "order placed"
  arrived): it is returned with its status and customer, with items, total and placement time
  `null`. This is the same behaviour as the list (US-06).
- **Id in uppercase**: UUIDs are case-insensitive, so an uppercase spelling of an existing order's
  id returns that order.
- **Read model unavailable**: the query returns the same "temporarily unavailable" error as the
  list (`SERVICE_UNAVAILABLE`, no internal details), never `null` as if the order did not exist.
- **Read-model bookkeeping fields** are never exposed. The result uses the same `Order` type as the
  list.
- **Requesting the order and the list in one GraphQL document**: both are answered independently
  from the same read model.

## Requirements *(mandatory)*

### Functional Requirements

**Query**

- **FR-001**: The GraphQL API MUST offer a query `order(orderId: ID!)` that returns the existing
  `Order` type (the same one the `orders` list returns), or `null`.
- **FR-002**: When an order with that id exists in the read model, the query MUST return it with
  the same field values the `orders` list would show for it.
- **FR-003**: When no order with that id exists, the query MUST return `null` and the response MUST
  NOT contain an `errors` entry.
- **FR-004**: The lookup MUST treat the id case-insensitively, since UUIDs are case-insensitive.

**Validation and errors**

- **FR-005**: `orderId` MUST be validated with a `class-validator` argument class. A value that is
  not a UUID MUST produce a GraphQL error with code `BAD_USER_INPUT` naming `orderId`, with no
  data and no crash.
- **FR-006**: If the read model is unreachable, the query MUST fail with the same
  `SERVICE_UNAVAILABLE` error as the list query, never return `null`.

**Read-path architecture (Constitution Principle II)**

- **FR-007**: The query MUST flow resolver → query bus → get-order query handler → read-model
  repository lookup by document id. It MUST NOT dispatch commands or access PostgreSQL, the
  write-model persistence entities, or the domain aggregate.
- **FR-008**: The existing GraphQL `Order` type, the read-model repository, the read-model module
  and the GraphQL error handling MUST be reused, not duplicated.

**Documentation**

- **FR-009**: The query and its argument MUST have descriptions. The query's description MUST say
  that a just-placed order may briefly return `null` because the read model is eventually
  consistent.
- **FR-010**: The committed schema (`docs/schema.gql`) MUST include the new query. `README.md` MUST
  show an example `order` query (found, not found, malformed id). `CLAUDE.md` MUST mention the new
  query where it lists the read path.

### Key Entities

- **Order (GraphQL)**: unchanged from US-06. Returned singly by this query.
- **Order View** (read model, US-05): the document looked up by its id. Unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An order placed through the public API can be fetched by its id within 5 seconds,
  and shows its final status within 5 seconds of the payment outcome.
- **SC-002**: For every order, fetching it by id returns exactly the same field values as its
  entry in the list (0 differences).
- **SC-003**: 100% of lookups for well-formed but unknown ids return an empty result with no error.
- **SC-004**: 100% of malformed ids are rejected with a descriptive error, and 0 crash the service.
- **SC-005**: A lookup by id returns in under 200 ms with 10,000 orders in the read model (a direct
  key lookup).

## Assumptions

- **Source of truth for the answer** is the read model only, so freshness is that of the US-05
  projection (normally under a second). A just-placed order returning `null` briefly is expected
  and documented, not a bug.
- **"Not a valid UUID"** follows the same rule as the list's `customerId` argument (any UUID
  version). Ids are generated by the write side as UUID v4 in lowercase.
- **Case-insensitive lookup**: the id is normalised to lowercase before the lookup, because stored
  ids are lowercase.
- **Error codes** reuse US-06's conventions: `BAD_USER_INPUT` for an invalid argument,
  `GRAPHQL_VALIDATION_FAILED` for a missing required argument, and `SERVICE_UNAVAILABLE` for a
  read-model outage.
- **No authentication or authorisation**: anyone who can reach the endpoint can read any order by
  id (out of scope, as for the list).
- **Out of scope**: mutations, authentication, new filters on the list query, dead-letter retry
  (US-08).
- **Tests required**:
  - unit tests for the query handler (found, not found, id normalisation, errors propagate) and
    for the resolver mapping;
  - integration tests sending real GraphQL queries against a MongoDB container (found, the same
    values as the list, not found → `null` without errors, malformed and missing id, uppercase
    id, outage);
  - a component test of the full flow (REST → Kafka → projection → MongoDB → GraphQL `order`),
    including a confirmation.
