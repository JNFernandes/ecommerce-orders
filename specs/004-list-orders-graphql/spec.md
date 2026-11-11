# Feature Specification: List Orders over GraphQL (US-06)

**Feature Branch**: `feature/US-06-list-orders-graphql`

**Created**: 2026-11-11

**Status**: Draft

**Input**: User description: "US-06 List orders (GraphQL). As an API consumer, I query a paged,
filterable list of orders over GraphQL so that I can see orders without touching the write side."
(full description, including behaviour, scope and acceptance criteria, is reflected in the
Requirements and Assumptions below)

## User Scenarios & Testing *(mandatory)*

The actor is an **API consumer**: a front end, an operator tool, or another service. It wants to
browse orders: all of them, one customer's, or those in a given status, a page at a time. The
answers come from the read model built in US-05, never from the write side. This is the first
consumer-facing piece of the CQRS read path described in ADR 0001.

### User Story 1 - Browse recent orders, a page at a time (Priority: P1)

The consumer asks for orders and gets the newest first, a page at a time. With each page it also
gets how many orders exist in total and whether there is a next page.

**Why this priority**: This is the minimum useful read API. Without it nothing can be listed.

**Independent Test**: Place three orders through the existing REST endpoint, then ask for orders
with a page size of 2. The first page has the two newest orders, a total count of at least 3, and
"has next page" true. The second page continues where the first stopped, with no duplicates and
no gaps.

**Acceptance Scenarios**:

1. **Given** orders exist in the read model, **When** the consumer asks for orders without
   arguments, **Then** it gets up to 20 orders sorted newest first (by placement time), the total
   number of orders, and whether more exist.
2. **Given** 25 orders exist, **When** the consumer asks for page size 10 at offset 20, **Then** it
   gets 5 orders, total count 25, and "has next page" false.
3. **Given** an order was just placed, **When** it appears in the list (within a few seconds,
   since the read model is eventually consistent), **Then** its status, customer, items with
   subtotals, total and timestamps match the order that was placed.
4. **Given** an order's payment outcome has been processed, **When** it is listed, **Then** it shows
   `CONFIRMED` with its confirmation time, or `CANCELLED` with its cancellation time and reason.

---

### User Story 2 - Filter by status and by customer (Priority: P1)

The consumer narrows the list to one status, to one customer, or to both at once.

**Why this priority**: "My orders" (by customer) and "orders waiting for payment" (by status) are
the two everyday questions. Both filters are in the acceptance criteria.

**Independent Test**: Create orders for two customers, with different outcomes. Filtering by
customer A returns only A's orders. Filtering by `CANCELLED` returns only cancelled orders.
Combining both returns only A's cancelled orders. Each total count matches its filter.

**Acceptance Scenarios**:

1. **Given** orders for several customers, **When** the consumer filters by one customer id,
   **Then** only that customer's orders are returned, and the total count counts only those.
2. **Given** orders in all three statuses, **When** the consumer filters by `CONFIRMED`, **Then**
   only confirmed orders are returned.
3. **Given** both filters, **When** the consumer queries, **Then** only orders matching both are
   returned.
4. **Given** a filter that matches nothing, **When** the consumer queries, **Then** it gets an
   empty list, total count 0 and "has next page" false. This is not an error.

---

### User Story 3 - Clear errors for invalid requests (Priority: P2)

A consumer that sends a bad argument gets a clear, machine-readable error that says what is
wrong. The service keeps working normally for everyone else.

**Why this priority**: Without it, mistakes surface as crashes or silent truncation, and
consumers cannot tell their bug from a server bug.

**Independent Test**: Ask for page size 0, page size 101, offset -1, an unknown status, and a
customer id that is not a UUID. Each returns a GraphQL error naming the offending argument and no
data. A valid query sent right after succeeds.

**Acceptance Scenarios**:

1. **Given** a page size outside 1–100, **When** queried, **Then** the response is a GraphQL error
   identifying `limit` and its allowed range, marked as a bad user input.
2. **Given** a negative offset, **When** queried, **Then** a bad-user-input error identifies
   `offset`.
3. **Given** a status that is not `PENDING`, `CONFIRMED` or `CANCELLED`, **When** queried, **Then**
   the response is a GraphQL validation error naming the allowed values.
4. **Given** a customer id that is not a UUID, **When** queried, **Then** a bad-user-input error
   identifies `customerId`.
5. **Given** any of the errors above, **When** the next valid query arrives, **Then** it succeeds.
   An invalid request never crashes the service.

---

### User Story 4 - Discover the API (Priority: P3)

A developer can explore the schema, every type and field with its description, and try queries
interactively, outside production.

**Why this priority**: Useful for adoption and debugging. The API works without it.

**Independent Test**: Outside production, open `/graphql` in a browser and get the interactive
sandbox, and an introspection query returns the schema with descriptions. In production,
introspection is refused and the sandbox is not served.

**Acceptance Scenarios**:

1. **Given** a non-production environment, **When** a developer opens the GraphQL endpoint in a
   browser, **Then** an interactive sandbox is served.
2. **Given** a non-production environment, **When** an introspection query is sent, **Then** the
   schema is returned, and every type, field and argument has a description.
3. **Given** a production environment, **When** an introspection query is sent, **Then** it is
   rejected and no sandbox page is served.
4. **Given** the repository, **When** a developer opens the committed schema document in `docs/`,
   **Then** it matches what the service actually serves.

---

### Edge Cases

- **Order known only from its confirmation or cancellation** (the read model has a view created by
  an early terminal event, before "order placed" arrived): it is listed with its status and
  customer, while items, total and placement time are empty (null) until "order placed" is
  projected. Orders without a placement time sort after all orders that have one.
- **Same placement time**: ties are broken by order id, so pages stay stable and no order appears
  on two pages or on none.
- **Offset beyond the end**: an empty page, the correct total count, and "has next page" false.
- **Orders added between two page requests**: the newest-first ordering means a new order shifts
  later pages by one. Offset paging does not hide this, and it is accepted (see Assumptions).
- **Read model unavailable** (MongoDB down): the query returns a GraphQL error that says the
  service is temporarily unavailable. It never returns a partial or empty list as if it were real.
  The HTTP API and the consumers keep working.
- **Write side ahead of the read model**: an order that exists in PostgreSQL but has not been
  projected yet is not listed. This is expected eventual consistency, not an error.
- **Bookkeeping fields** of the read model (applied event ids, revision, which event decided the
  status) are never exposed.

## Requirements *(mandatory)*

### Functional Requirements

**Endpoint**

- **FR-001**: The service MUST expose a GraphQL API at `/graphql`, defined code-first, alongside the
  existing REST API.
- **FR-002**: Introspection and the interactive sandbox MUST be enabled when the service is not
  running in production, and disabled in production.

**Query**

- **FR-003**: The API MUST offer a query `orders(status, customerId, limit, offset)` returning an
  `OrdersPage` with `items` (list of `Order`), `totalCount` and `hasNextPage`.
- **FR-004**: `status` and `customerId` MUST be optional, independent filters that combine with
  AND.
- **FR-005**: `limit` MUST default to 20 and be between 1 and 100 inclusive. `offset` MUST default to
  0 and be ≥ 0.
- **FR-006**: Results MUST be sorted by placement time, newest first. Ties are broken by order id
  (descending), and orders without a placement time come last.
- **FR-007**: `totalCount` MUST be the number of orders matching the filters, ignoring paging.
  `hasNextPage` MUST be true exactly when `offset + returned items < totalCount`.

**Schema**

- **FR-008**: The `Order` type MUST expose `orderId`, `customerId`, `status` (enum `OrderStatus`:
  `PENDING`, `CONFIRMED`, `CANCELLED`), `items` (each with `productId`, `quantity`, `unitPrice`,
  `subtotal`), `totalAmount`, `placedAt`, `confirmedAt`, `cancelledAt` and `cancellationReason`.
  Fields that can be unknown in the read model (`items`, `totalAmount`, `placedAt`) and fields that
  only apply to one status MUST be nullable. The read model's internal bookkeeping fields MUST NOT
  be exposed.
- **FR-009**: Every GraphQL type, field, argument and enum value MUST have a description visible
  through introspection (Constitution, Documentation Standards).

**Validation and errors**

- **FR-010**: The query arguments MUST be validated with `class-validator` argument classes. An
  invalid `limit`, a negative `offset` or a non-UUID `customerId` MUST produce a GraphQL error with
  code `BAD_USER_INPUT` that names the argument and the rule. An unknown `status` MUST be rejected
  by GraphQL's enum validation. None of these may crash the service or affect other requests.
- **FR-011**: If the read model is unreachable, the query MUST fail with a GraphQL error indicating
  temporary unavailability, without internal details such as stack traces or connection strings.

**Read-path architecture (Constitution Principle II)**

- **FR-012**: The query MUST flow resolver → query bus → query handler → read-model repository
  (MongoDB). The resolver MUST NOT dispatch commands, and nothing in the read path may access
  PostgreSQL, the write-model persistence entities, or the domain aggregate.
- **FR-013**: GraphQL types MUST be classes separate from the write-model persistence entities and
  the domain aggregate.

**Performance**

- **FR-014**: The read model MUST have indexes supporting each filter combined with the sort:
  `{customerId, placedAt}` and `{status, placedAt}`.

**Documentation**

- **FR-015**: The GraphQL schema MUST be committed under `docs/`, and a check MUST fail when it no
  longer matches the schema the service serves.
- **FR-016**: `README.md` MUST include example queries (unfiltered, filtered, paged). `CLAUDE.md`
  and the other docs that describe GraphQL as planned MUST be updated.

### Key Entities

- **Order (GraphQL)**: the consumer-facing representation of an order, derived from the read
  model's order view. Fields per FR-008.
- **Order Item (GraphQL)**: one line of an order: product, quantity, unit price, subtotal.
- **OrdersPage**: one page of results: the orders, the total matching count, and whether more
  exist.
- **Order View** (existing, US-05): the read-model document the API reads from. It is unchanged,
  apart from the new indexes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An order placed through the public API appears in the list within 5 seconds, with
  the same status, customer, items and total as the write side once its events have been
  projected.
- **SC-002**: Paging through any filter with any page size returns every matching order exactly
  once (0 duplicates, 0 omissions) when no orders are added in between.
- **SC-003**: `totalCount` equals the number of matching orders in 100% of tested filter
  combinations.
- **SC-004**: 100% of invalid argument cases from User Story 3 return a descriptive error, and
  0 crash the service.
- **SC-005**: A page of up to 100 orders is returned in under 1 second with 10,000 orders in the
  read model (indexes in use).
- **SC-006**: Every type, field, argument and enum value in the published schema has a
  description (0 missing).

## Assumptions

- **Read model as source**: the list reads only the US-05 `order_views` collection, so its
  freshness is that of the projection (normally under a second). A just-placed order may briefly
  be missing. This is intended (ADR 0001).
- **Out-of-range `limit` is an error, not clamped**, as the description says ("invalid limit …
  produce a GraphQL error"). The allowed range is 1–100.
- **`customerId` must be a UUID**, because customer ids are UUIDs on the write side. Anything else
  is a bad-user-input error rather than an empty result.
- **Offset paging** is used as requested. Consumers who page while orders are being placed may see
  shifted pages. Cursor paging could be added later if needed.
- **`totalCount` and `items` come from two read-model reads**, so under concurrent projection they
  may be off by one momentarily. This is acceptable for an eventually consistent list.
- **"Production"** means `NODE_ENV=production`.
- **Money** is exposed as a GraphQL `Float` and timestamps as ISO-8601 `DateTime`, matching the
  REST API and the events.
- **No authentication or authorisation** in this story. Anyone who can reach the endpoint can
  list all orders (out of scope, as stated).
- **Out of scope**: order by id (US-07), mutations, subscriptions, authentication, dead-letter
  retry (US-08).
- **Tests required**:
  - unit tests for the query handler (and argument validation);
  - integration tests sending real GraphQL queries to the app against a MongoDB container
    (filters, paging, sorting, errors);
  - a component test with the full stack (REST → PostgreSQL → Kafka → projection → MongoDB →
    GraphQL) placing an order and finding it in the `orders` query.
