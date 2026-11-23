# Feature Specification: Scope the GraphQL Read Model by Owner (US-12)

**Feature Branch**: `feature/US-12-graphql-owner-scope`

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "US-12: Scope the GraphQL read model by owner. US-11 made the GraphQL
endpoint require a valid token. This story makes the results depend on who is asking, for the
existing orders list query and the existing order by id query. CUSTOMER: results always restricted
to the customerId in the token, applied in the read-model query itself so totals, pagination and
counts only reflect the caller's own orders. A CUSTOMER filtering on another customerId gets an
empty result with total 0; an order owned by someone else looks exactly like an unknown id. ADMIN
sees all orders and the customerId filter works normally. A token without a customerId and without
ADMIN gets FORBIDDEN. Existing filters, sorting and pagination keep working inside the scope. No
schema changes beyond what the README documents; tokens never in logs or errors. The read model
gets an index supporting the scoped queries through the existing index creation mechanism. Out of
scope: row-level rules for other types, query depth/complexity limits, subscriptions, any REST
change."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A customer lists only their own orders (Priority: P1)

A signed-in customer asks for their order list. They see only the orders they placed, and every
number on the page (total count, "has next page") describes their own orders only. Status filters,
the newest-first ordering and paging behave exactly as before, just within their own orders.

**Why this priority**: Today any customer can list every customer's orders. Closing that leak is
the core of the story and is valuable on its own.

**Independent Test**: Project orders for customers A and B, call the list as customer A with no
filter, with a status filter and with several page sizes/offsets; check that only A's orders come
back, in the usual order, and that the total and "has next page" match A's orders alone.

**Acceptance Scenarios**:

1. **Given** customer A has 3 orders and customer B has 5, **When** A lists orders with no
   filter, **Then** A receives exactly their 3 orders, newest first, with a total of 3.
2. **Given** customer A has 25 orders and others exist for B, **When** A lists with a page size of
   10 and offset 20, **Then** A receives their 5 oldest orders, the total is 25 and there is no
   next page.
3. **Given** A has 2 confirmed and 1 pending order and B has confirmed orders too, **When** A lists
   confirmed orders, **Then** A receives only their 2 confirmed orders with a total of 2.
4. **Given** A has orders, **When** A lists orders filtered by their own customer id, **Then** the
   result is the same as with no customer filter.
5. **Given** A has orders, **When** A lists orders filtered by customer B's id, **Then** the result
   is empty, the total is 0, there is no next page and no error is returned.

---

### User Story 2 - A customer can only open their own order (Priority: P1)

A signed-in customer asks for one order by id. If the order is theirs they get it. If it belongs
to someone else they get the same "not found" answer as for an id that does not exist, so they can
never learn that the order exists.

**Why this priority**: Same leak as Story 1 on the single-order query; equally critical, and
testable on its own.

**Independent Test**: Project an order for A and one for B; ask for each as A, and ask for a
random unknown id as A; compare the answers.

**Acceptance Scenarios**:

1. **Given** order X belongs to A, **When** A asks for X, **Then** A receives X.
2. **Given** order Y belongs to B, **When** A asks for Y, **Then** the answer is "no order" (null)
   with no error, identical in shape to the answer for an unknown id.
3. **Given** no order has id Z, **When** A asks for Z, **Then** the answer is "no order" (null)
   with no error.

---

### User Story 3 - An administrator sees all orders (Priority: P2)

An administrator lists or opens orders without any restriction. The customer filter on the list
narrows results to that customer like a normal filter.

**Why this priority**: Preserves the existing back-office behaviour; nothing new is gained, but
scoping must not break it.

**Independent Test**: As an administrator, list with no filter, with a customer filter and open
orders of different customers.

**Acceptance Scenarios**:

1. **Given** orders exist for A and B, **When** an administrator lists with no filter, **Then** all
   orders are returned and the total counts all of them.
2. **Given** orders exist for A and B, **When** an administrator lists filtered by A, **Then** only
   A's orders are returned with A's total.
3. **Given** order Y belongs to B, **When** an administrator asks for Y, **Then** Y is returned.

---

### User Story 4 - A caller with no owner and no admin role is refused (Priority: P2)

A caller whose valid token has neither a customer id nor the administrator role cannot use the
order queries and gets a "forbidden" error instead of data.

**Why this priority**: Prevents an unscoped fallback (a token with no customer id must never be
treated as "see everything"). Already enforced since US-11; this story keeps it guaranteed.

**Independent Test**: Call both queries with a valid token that has the customer role but no
customer id, and with a valid token that has no roles.

**Acceptance Scenarios**:

1. **Given** a valid token with the customer role but no customer id, **When** the caller lists
   orders or asks for an order, **Then** they get a FORBIDDEN error and no order data.
2. **Given** a valid token with no recognised role, **When** the caller uses either query, **Then**
   they get a FORBIDDEN error and no order data.

---

### Edge Cases

- A token carrying both the administrator role and a customer id: the administrator rule applies
  (sees all orders; the customer filter is a normal filter).
- A customer whose own order has not been projected yet: the list does not include it and the
  single-order query returns "no order", exactly as today (eventual consistency).
- A customer passes another customer's id together with a status filter or paging: still empty,
  total 0, no next page, no error.
- A customer with no orders at all: empty list, total 0, no error.
- An offset past the end of the caller's own orders: empty page, total = the caller's own count.
- Invalid arguments (malformed customer id, out-of-range page size) still fail with the existing
  BAD_USER_INPUT error, for every caller, before any scoping question arises.
- The read store is unavailable: the existing SERVICE_UNAVAILABLE error, unchanged.
- Missing, expired or otherwise invalid tokens: handled by US-11 (UNAUTHENTICATED), unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: For a caller acting as a customer (has the customer role and a customer id, and not
  the administrator role), the order list MUST contain only orders whose owner is that customer id.
- **FR-002**: The customer restriction MUST be part of the read query itself, so the total count,
  "has next page" and paging windows are computed over the caller's own orders only. Fetching
  unrestricted results and removing others' orders afterwards is NOT acceptable.
- **FR-003**: When a customer passes a customer filter equal to their own id, the result MUST be the
  same as with no customer filter.
- **FR-004**: When a customer passes a customer filter different from their own id, the list MUST
  return no orders, a total of 0, no next page and no error, regardless of other arguments.
- **FR-005**: For a customer, the single-order query MUST return an order only if it belongs to
  them; an order owned by anyone else MUST produce the same result as an unknown id (null, no error
  entry), and the response MUST NOT differ in any way that reveals the order exists.
- **FR-006**: For an administrator, both queries MUST return results across all customers, and the
  list's customer filter MUST behave as a normal filter.
- **FR-007**: A caller with a valid token that has neither a customer id (with the customer role)
  nor the administrator role MUST receive a FORBIDDEN error and no order data on both queries.
- **FR-008**: The existing status filter, newest-first ordering (with its tie-breaking and
  "no placement time last" rule), page size limits and offset paging MUST keep working unchanged
  within the caller's scope.
- **FR-009**: The scoping decision MUST use only the verified caller identity; no client-supplied
  argument can widen the scope.
- **FR-010**: The read store MUST support every scoped list query (owner alone, owner plus status)
  together with the list ordering through an index, created by the existing index-creation step;
  no manual migration is required.
- **FR-011**: The GraphQL schema shape (types, fields, arguments) MUST NOT change. Descriptions of
  the two queries and of the customer filter MAY be updated to state the scoping rules, and the
  README MUST document who sees what.
- **FR-012**: Tokens MUST never appear in logs, error messages or responses, including any new
  logging added for scoping.
- **FR-013**: The REST API, the write side and every other GraphQL type MUST be unaffected.

### Key Entities

- **Caller (requester)**: the verified identity behind a request: an optional customer id and a
  set of effective roles (customer, administrator). Decides the scope.
- **Read scope**: either "all orders" (administrator) or "orders of customer X" (customer). Applied
  to every order query; a mismatching requested customer yields an empty scope.
- **Order view**: the read-model representation of an order, already carrying its owner's customer
  id, status and placement time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated tests, 0 orders belonging to another customer are ever returned to a
  customer, across every combination of filters and paging tested.
- **SC-002**: For a customer, the reported total equals the number of their own orders matching
  the filters in 100% of tested cases, and paging through all pages returns each of their orders
  exactly once.
- **SC-003**: The answer for another customer's order id is indistinguishable from the answer for
  an unknown id (same data, same absence of errors) in 100% of tested cases.
- **SC-004**: Administrators see the same results as before this story for every existing query in
  the test suite (no regression).
- **SC-005**: Customers' scoped list queries are served from an index (no full scan of all orders),
  verified for both "owner" and "owner plus status" queries.
- **SC-006**: A scan of logs and error bodies produced by the tests finds no token material.

## Assumptions

- Effective roles are computed as in US-11: the customer role counts only when the token carries a
  customer id. Callers without the customer or administrator role are already refused by the
  existing role check; this story keeps that behaviour and adds scoping behind it.
- When a token has both roles, the administrator rule wins.
- Every order view already stores its owner's customer id; no projection change or backfill is
  needed.
- An index on owner + placement time already exists for the customer filter (US-06); a combined
  owner + status + placement time index is added so customer queries with a status filter are also
  index-backed. Both are created by the existing startup index creation.
- Ownership on the write side remains a domain rule (`Order.isAccessibleBy`); the read side cannot
  reuse it (CQRS separation), so it applies the equivalent read-side rule in its own query layer.
- Out of scope: row-level rules for other types, query depth/complexity limits, subscriptions, and
  any REST change.
