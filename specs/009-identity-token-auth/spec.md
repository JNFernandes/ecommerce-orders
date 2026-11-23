# Feature Specification: Authenticate with the Identity Token and Own Your Orders (US-11)

**Feature Branch**: `feature/US-11-identity-token-auth`

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "US-11: Authenticate with the Identity token and own your orders
(REST). Orders verifies the access tokens issued by ecommerce-identity locally, without calling
Identity per request, using its JWKS (see ecommerce-identity README and the Identity constitution
for the token claims: sub, customerId (customers only), roles, iss, aud, exp, kid)." (the full
verification rules, REST rules and out-of-scope list are reproduced in the Requirements and
Assumptions below)

## Clarifications

### Session 2026-11-23

- Q: What happens when the key set cannot be fetched and no keys are loaded? → A: `503` (not
  `401`); see FR-010.
- Q: What access does GraphQL get in this story? → A: A valid token with `CUSTOMER` or `ADMIN` is
  required; results are not scoped to the caller until US-12; see FR-021, FR-022.
- Q: What happens to the `customerId` field of the place-order body? → A: It is removed from the
  request contract (and from the API docs); sending it is rejected `400`; see FR-015.
- Q: What does a customer get for an order owned by someone else? → A: `404`, identical to an
  order that does not exist, never `403`; see FR-018.
- Q: Is token revocation part of this story? → A: No; a token stays valid until it expires; see
  Assumptions.

## User Scenarios & Testing *(mandatory)*

Today every Orders endpoint is open: anyone who can reach the service can place an order for any
customer id, cancel any order, or force-confirm an order past the payment/stock join. This story
makes Orders trust only the access tokens issued by Identity and ties each order action to the
person holding the token.

Actors:

- **Customer**: a user whose token carries the `CUSTOMER` role and a `customerId`. Places orders
  for themselves and cancels their own pending orders.
- **Admin (operator)**: a user whose token carries the `ADMIN` role. Cancels any pending order
  and is the only one allowed to confirm an order by hand.
- **Anonymous caller / attacker**: has no token, an expired one, a forged one or someone else's
  order id. Must learn nothing and change nothing.
- **Identity service**: issues the tokens and publishes the public keys that verify them. Orders
  never calls it per request.

Facts about Identity tokens this story relies on (Identity README, "Access token" and "Verifying
access tokens"; Identity constitution, Principle II): RS256 signature, header carries a `kid`;
claims are exactly `sub` (user id), `customerId` (present only when the roles include
`CUSTOMER`), `roles` (one or both of `CUSTOMER`, `ADMIN`), `iss`, `aud`, `iat`, `exp`, `jti`;
lifetime 15 minutes by default; keys published at `/.well-known/jwks.json`, several at a time
during a rotation.

### User Story 1 - Only callers with a valid Identity token get in (Priority: P1)

Every request to a protected Orders endpoint must carry a valid Identity access token. Orders
checks the token itself, with Identity's published public keys, and rejects anything it cannot
fully trust with one generic answer that does not say what was wrong.

**Why this priority**: Every other rule in this story (ownership, roles) depends on knowing who
the caller is. Without it the remaining stories have nothing to check against.

**Independent Test**: Against Orders with a reachable key set, send requests to a protected
endpoint with no token, a malformed token, an expired token, a token signed by an unknown key, an
`alg: none` token, an HS256 token (including one signed with the public key as the secret), a
token with the wrong issuer, and one with the wrong audience; each gets the same `401` with
`WWW-Authenticate: Bearer` and the same body. A valid token gets through. The public endpoints
answer without a token.

**Acceptance Scenarios**:

1. **Given** a request to a protected endpoint with no `Authorization` header, or one that is not
   `Bearer <token>`, **When** it is received, **Then** it is answered `401` with
   `WWW-Authenticate: Bearer` and a generic body, and nothing is changed.
2. **Given** a token that is malformed, has a bad signature, is signed by a key Orders does not
   know, uses an algorithm other than RS256 (including `none` and HS256 signed with the public
   key), has no `kid`, has an issuer other than the configured one, does not name the configured
   audience, or is expired by more than the clock tolerance, **When** it is presented, **Then**
   the answer is byte-for-byte the same `401` as in scenario 1 (status, `WWW-Authenticate` header
   and body).
3. **Given** a token expired by less than the clock tolerance (default 5 seconds), **When** it is
   presented, **Then** it is accepted.
4. **Given** a valid token, **When** it is presented, **Then** the request reaches the endpoint
   with the verified user id, customer id (if any) and roles, and those values come only from the
   verified token.
5. **Given** any rejected request, **When** the service logs it or answers it, **Then** neither
   the log nor the answer contains the token or any part of it.
6. **Given** the Swagger UI (and its API document) and the health endpoint (if one exists),
   **When** they are requested without a token, **Then** they answer normally.

---

### User Story 2 - Customers place orders only for themselves (Priority: P1)

A customer places an order without saying who they are in the request: Orders takes the customer
id from their token. Someone without a customer identity cannot place orders, and nobody can place
an order on behalf of someone else.

**Why this priority**: Placing an order for an arbitrary customer id is the most direct abuse of
the open API today, and it is the main customer journey.

**Independent Test**: With a `CUSTOMER` token for customer `C`, place an order whose body holds
only the items; the saved order and the published "order placed" event name `C`. The same body
with an added `customerId` (any value, even `C`) is rejected `400`. An `ADMIN`-only token gets
`403`. A `CUSTOMER` token without a `customerId` gets `403`.

**Acceptance Scenarios**:

1. **Given** a valid token with role `CUSTOMER` and `customerId` `C`, where `C` exists in Orders,
   **When** the customer places an order with a body holding only `items`, **Then** the order is
   created for customer `C`, as today (saved first, then "order placed" published).
2. **Given** the same token, **When** the body also contains `customerId` (whatever its value) or
   any other property not in the contract, **Then** the request is rejected `400` and nothing is
   saved or published.
3. **Given** a valid token whose roles do not include `CUSTOMER` (for example an admin), **When**
   it is used to place an order, **Then** the answer is `403` and nothing is saved or published.
4. **Given** a valid token with role `CUSTOMER` but no `customerId` claim, **When** it is used to
   place an order, **Then** the answer is `403` and nothing is saved or published.
5. **Given** a valid `CUSTOMER` token for a customer Orders has not created yet (the registration
   has not been processed), **When** an order is placed, **Then** the answer is the usual `404`
   for an unknown customer, as today.
6. **Given** a user holding both `CUSTOMER` and `ADMIN` with a `customerId`, **When** they place
   an order, **Then** it is created for their own `customerId`.

---

### User Story 3 - Customers cancel only their own orders; admins can cancel any (Priority: P1)

A customer can cancel their own pending order. An order that belongs to someone else looks exactly
like an order that does not exist. An admin can cancel any pending order, for support purposes.
The existing cancellation rules (only `PENDING` orders, cancellation event published after the
save) stay as they are.

**Why this priority**: Without ownership, any authenticated customer could cancel anyone's order,
which is as bad as no authentication for this endpoint.

**Independent Test**: Place an order as customer `A`. As customer `B`, cancel it: `404`, same body
as for a random order id, order still `PENDING`. As `A`, cancel it: `200`, `CANCELLED`. Place
another order as `A`; as an admin, cancel it: `200`.

**Acceptance Scenarios**:

1. **Given** a `PENDING` order owned by customer `A`, **When** `A` cancels it, **Then** it is
   cancelled exactly as today.
2. **Given** an order owned by customer `A` (in any status), **When** customer `B` tries to
   cancel it, **Then** the answer is the same `404` (status and body) as for an order id that does
   not exist, and the order is not changed and nothing is published.
3. **Given** a `PENDING` order owned by anyone, **When** an admin cancels it, **Then** it is
   cancelled exactly as today.
4. **Given** an order owned by `A` that is no longer `PENDING`, **When** `A` or an admin tries to
   cancel it, **Then** the existing "not cancellable" rejection (`409`) applies.
5. **Given** a token whose roles include neither `CUSTOMER` nor `ADMIN`, **When** it is used to
   cancel, **Then** the answer is `403`.
6. **Given** a `CUSTOMER`-only token without a `customerId`, **When** it is used to cancel,
   **Then** the answer is `403`.
7. **Given** a user holding both roles, **When** they cancel an order owned by someone else,
   **Then** the admin rule applies and the `PENDING` order is cancelled.

---

### User Story 4 - Only admins can confirm an order by hand (Priority: P1)

Manual confirmation bypasses the payment + stock join, so it is an operator override: admins
only.

**Why this priority**: A customer confirming their own order without payment would ship unpaid
goods. One rule, but a critical one.

**Independent Test**: With a `CUSTOMER` token, confirm a pending order: `403`, order unchanged.
With an `ADMIN` token: `200`, `CONFIRMED`.

**Acceptance Scenarios**:

1. **Given** a `PENDING` order, **When** an admin confirms it, **Then** it is confirmed exactly as
   today.
2. **Given** any order, **When** a caller without the `ADMIN` role tries to confirm it, **Then**
   the answer is `403`, the order is unchanged and nothing is published.
3. **Given** an admin, **When** they confirm an order that does not exist or is not `PENDING`,
   **Then** the existing `404` / `409` answers apply.

---

### User Story 5 - Orders keeps working when Identity is slow, down or rotating keys (Priority: P2)

Orders fetches Identity's public keys only when it needs them, keeps them, and fetches them again
only when a token names a key it has not seen (at most once per minute). It starts and serves its
public endpoints, Kafka consumers and dead-letter retries even when Identity cannot be reached.

**Why this priority**: Authentication must not make Identity a hard runtime dependency of Orders
or a per-request bottleneck. It is P2 because the P1 stories can be shown with Identity up.

**Independent Test**: Start Orders with Identity stopped: it starts; public endpoints answer; a
protected request gets `503`. Start Identity: the next protected request with a valid token
succeeds. Send 100 valid requests: at most one key fetch. Rotate Identity's signing key: a token
signed by the new key is accepted without restarting Orders, and a burst of tokens with random
unknown `kid`s causes at most one key fetch per minute.

**Acceptance Scenarios**:

1. **Given** Identity is unreachable, **When** Orders starts, **Then** it starts normally, and
   its public endpoints, Kafka consumers, projection and dead-letter retries work.
2. **Given** no keys have been loaded yet and the key set cannot be fetched, **When** a request
   with a token arrives, **Then** the answer is `503` (not `401`), with a generic body and no
   token in it or in the logs.
3. **Given** keys are already loaded, **When** valid tokens signed with a known key arrive,
   **Then** they are verified without contacting Identity.
4. **Given** keys are loaded and a token names an unknown `kid`, **When** no refetch happened in
   the last minute, **Then** Orders refetches the key set once and accepts the token if the key is
   now present; otherwise `401`.
5. **Given** a refetch happened less than a minute ago, **When** another token with an unknown
   `kid` arrives, **Then** it is rejected `401` without contacting Identity.
6. **Given** keys are loaded and a refetch fails, **When** tokens signed by a known key arrive,
   **Then** they keep being accepted with the keys already loaded.
7. **Given** many requests arrive at the same moment while no keys are loaded, **When** they are
   verified, **Then** Identity receives a single key-set request, not one per request.

---

### User Story 6 - Every route has an explicit access rule, visible in the API docs (Priority: P2)

Nothing is open by accident: a route is either explicitly public or explicitly limited to roles.
A route with no rule stops the service from starting. The Swagger document shows how to send the
token and which roles each operation needs.

**Why this priority**: Default deny protects every future endpoint, and the docs tell client
developers what each operation requires. It changes no request behaviour by itself.

**Independent Test**: Add a route with no access rule in a test module: the application fails to
start with an error naming it. Open the Swagger document: it declares a bearer scheme, every
protected operation references it and states its roles, public operations state they are public.

**Acceptance Scenarios**:

1. **Given** a REST route or GraphQL operation marked neither public nor with roles, **When** the
   application starts, **Then** startup fails with an error naming the route.
2. **Given** the Swagger document, **When** a reader looks at it, **Then** it declares a bearer
   (JWT) security scheme; `POST /orders` states `CUSTOMER`, cancel states `CUSTOMER` (own orders)
   or `ADMIN` (any order), confirm states `ADMIN`; each protected operation documents its `401`,
   `403` and `503` answers.

---

### User Story 7 - GraphQL requires a token (not yet scoped) (Priority: P2)

The GraphQL order queries now require a valid token with `CUSTOMER` or `ADMIN`. Results are not
yet limited to the caller's own orders; that is US-12, and the README says so.

**Why this priority**: It closes anonymous access to every order in the read model now, while
the scoping rule gets its own story.

**Independent Test**: Run the `orders` and `order(orderId)` queries without a token: an
`UNAUTHENTICATED` error and no data. With a `CUSTOMER` or `ADMIN` token: results as today. Read
the README: it states GraphQL is not scoped until US-12.

**Acceptance Scenarios**:

1. **Given** no token or an invalid one, **When** any GraphQL operation runs, **Then** no order
   data is returned and the response carries an error coded `UNAUTHENTICATED`, with no detail
   about why the token was rejected.
2. **Given** a valid token whose roles include neither `CUSTOMER` nor `ADMIN`, **When** a query
   runs, **Then** the response carries an error coded `FORBIDDEN` and no order data.
3. **Given** keys cannot be fetched and none are loaded, **When** a query runs, **Then** the
   response carries an error coded `SERVICE_UNAVAILABLE`.
4. **Given** a valid `CUSTOMER` or `ADMIN` token, **When** `orders` or `order(orderId)` runs,
   **Then** the result is the same as today (all orders, not scoped).
5. **Given** the README, **When** a reader looks up GraphQL access, **Then** it states a token is
   required and that results are not scoped to the caller until US-12.

---

### Edge Cases

- **Order of checks**: authentication (`401` / `503`) first, then role and customer-identity
  checks (`403`), then request validation (`400`), then the business rules (`404` / `409`). A
  request with no token and a bad body gets `401`, not `400`.
- **Unknown roles** in the token (neither `CUSTOMER` nor `ADMIN`) are ignored; a token with only
  unknown roles or an empty list is authenticated but forbidden (`403`) on every role-limited
  route.
- **Claims of the wrong shape** (no `sub`, `roles` not a list of strings, `customerId` not a
  UUID): treated as an invalid token, `401`.
- **`aud` as a list**: accepted when it contains the configured audience.
- **Token issued in the future / not-yet-valid**: if `nbf` or `iat` is later than now plus the
  clock tolerance, the token is invalid (`401`).
- **Role changed or user disabled in Identity after the token was issued**: the token stays valid
  in Orders until it expires (at most the token lifetime, 15 minutes by default). Revocation is
  out of scope.
- **Key removed from Identity's key set** (retired or compromised): Orders stops accepting it at
  its next key-set refresh (see FR-009), not immediately.
- **Customer cancels a non-existent order id**: `404`, identical to "owned by someone else".
- **Malformed order id** in the path: the existing `400` applies after authentication.
- **Identity answers the key-set request with an error, a non-JSON body or no usable RS256
  key**: treated as "keys cannot be fetched" (`503` if no keys are loaded, otherwise keep the
  loaded keys).
- **Kafka consumers, projection and dead-letter retry worker**: no token involved; their
  behaviour is unchanged.
- **Same customer, both roles**: the admin rules apply where they are broader (cancel any order);
  placing an order always uses their own `customerId`.

## Requirements *(mandatory)*

### Functional Requirements

**Token verification**

- **FR-001**: The system MUST verify Identity access tokens locally, with Identity's published
  public keys, and MUST NOT call Identity per request.
- **FR-002**: The system MUST accept only tokens signed with RS256 whose header names a `kid`
  present in the loaded key set, using only that key (never trying every key). `none`, HS256
  (including HS256 signed with a public key as the secret) and every other algorithm MUST be
  rejected.
- **FR-003**: The system MUST require the token's issuer to equal `JWT_ISSUER` and its audience
  to equal or contain `JWT_AUDIENCE`, and MUST reject a token expired by more than
  `JWT_CLOCK_TOLERANCE_SECONDS` (default 5). The same tolerance applies to not-before and
  issued-at checks.
- **FR-004**: The system MUST require the claims `sub` (non-empty string) and `roles` (list of
  strings); `customerId`, when present, MUST be a UUID. A token whose claims break these shapes is
  invalid.
- **FR-005**: Missing, malformed, invalid, expired, wrongly signed or wrongly addressed tokens MUST
  all get the same `401` answer: same status, a `WWW-Authenticate: Bearer` header, and the same
  generic body that does not say which check failed.
- **FR-006**: The user id, customer id and roles used by any endpoint MUST come only from the
  verified token and MUST be available to endpoints as a single "current user" value.
- **FR-007**: Tokens (whole or partial) MUST NOT appear in logs, error bodies or the Swagger
  document. Rejections MAY be logged with the failure category only.

**Key set**

- **FR-008**: The key set MUST be fetched from `IDENTITY_JWKS_URL` (default
  `http://localhost:3001/.well-known/jwks.json`) the first time a token must be verified, never
  at startup, and kept in memory. Concurrent requests while the set is loading MUST share one
  fetch.
- **FR-009**: When a token names an unknown `kid`, the system MUST refetch the key set at most
  once per minute (counted from the previous refetch; the first load does not count). The loaded
  set MUST also be refreshed on the next use once it is older than the max age Identity sends with
  it (falling back to 10 minutes when none is sent), so keys removed by Identity stop being
  accepted.
- **FR-010**: A failed fetch or refresh MUST NOT discard keys already loaded. When no keys are
  loaded and they cannot be fetched, the request MUST be answered `503` with a generic body.
- **FR-011**: The service MUST start, and its public endpoints, Kafka consumers, projection and
  dead-letter retries MUST work, when Identity is unreachable.

**Access rules**

- **FR-012**: Every REST route and GraphQL operation MUST require a valid token unless explicitly
  marked public. The Swagger UI with its API document, and any health endpoint, are public.
- **FR-013**: Every non-public route MUST declare the roles allowed to use it. A route that is
  neither public nor role-limited MUST make startup fail with an error naming it.
- **FR-014**: The recognised roles are `CUSTOMER` and `ADMIN`. A valid token without one of the
  route's roles MUST get `403` (GraphQL: error coded `FORBIDDEN`).

**Placing an order**

- **FR-015**: `POST /orders` MUST be limited to `CUSTOMER` and MUST place the order for the
  `customerId` of the token. The `customerId` field is removed from the request contract and its
  API documentation (the body holds only `items`): a body with `customerId` or any other property
  outside the contract MUST be rejected `400`.
- **FR-016**: A `CUSTOMER` token without a `customerId` MUST get `403` on `POST /orders`.
- **FR-017**: All other place-order rules stay unchanged, including the `404` for a customer
  Orders has not created yet.

**Cancelling and confirming**

- **FR-018**: `POST /orders/{id}/cancel` MUST be limited to `CUSTOMER` and `ADMIN`. A caller
  with `ADMIN` MAY cancel any `PENDING` order. A caller with only `CUSTOMER` MAY cancel only an
  order whose customer is the token's `customerId`; for any other order the answer MUST be the
  same `404` (status and body) as for an order that does not exist, with no change and nothing
  published. A `CUSTOMER`-only token without `customerId` MUST get `403`.
- **FR-019**: The ownership rule is a business rule and MUST be decided where the other order
  rules are decided, not in the HTTP layer. The existing cancellation rules (`PENDING` only,
  `409` otherwise, save first then publish) stay unchanged.
- **FR-020**: `POST /orders/{id}/confirm` MUST be limited to `ADMIN`; everything else about it
  stays unchanged.

**GraphQL**

- **FR-021**: Every GraphQL operation MUST require a valid token with `CUSTOMER` or `ADMIN`.
  Failures MUST return no order data and an error coded `UNAUTHENTICATED` (no or invalid token),
  `FORBIDDEN` (no allowed role) or `SERVICE_UNAVAILABLE` (keys unavailable), with no detail about
  the token.
- **FR-022**: GraphQL results MUST stay unscoped in this story (same results for every allowed
  caller); scoping is US-12.

**Unaffected flows**

- **FR-023**: Kafka consumers, the read-model projection, the dead-letter retry worker and the
  producer MUST keep working without any token and with unchanged behaviour.

**Configuration and documentation**

- **FR-024**: `IDENTITY_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` and `JWT_CLOCK_TOLERANCE_SECONDS`
  MUST be configurable through the environment and documented in the README and `.env.example`.
  `JWT_ISSUER` and `JWT_AUDIENCE` MUST be set: the service MUST refuse to start without them, with
  an error naming the missing variable.
- **FR-025**: The Swagger document MUST declare a bearer (JWT) scheme, reference it on every
  protected operation, state each operation's roles (public operations state they are public),
  and document the `401`, `403` and `503` answers.
- **FR-026**: The README MUST document how to call Orders with an Identity token (where to get
  one, the header), the access rule of each route, the `401` / `403` / `404` / `503` meanings,
  and that GraphQL is not scoped to the caller until US-12.

### Key Entities

- **Access token (verified)**: the caller's proof of identity, issued by Identity. Orders reads
  from it the user id (`sub`), the customer id (customers only) and the roles; it is never stored.
- **Current user**: the verified user id, optional customer id and roles of the request, handed
  to the endpoint. Never built from anything but a verified token.
- **Key set**: Identity's public keys, each identified by a `kid`, held in Orders' memory with the
  time it was loaded and the time of the last refetch.
- **Access rule**: per route, either "public" or the list of allowed roles.
- **Order owner**: the customer id already stored on each order; compared with the current
  user's customer id for customer cancellations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of protected routes reject each of the token failure cases of User Story 1
  (no token, malformed, bad signature, unknown key, `none`, HS256, HS256 with the public key,
  wrong issuer, wrong audience, expired) with the identical `401` answer.
- **SC-002**: A customer cannot place, cancel or confirm an order on another customer's behalf:
  0 successful attempts in the test suite, and the answer to "cancel someone else's order" is
  indistinguishable from "cancel an order that does not exist".
- **SC-003**: With keys loaded, 1,000 consecutive valid requests cause 0 requests to Identity;
  a burst of 1,000 tokens with unknown key ids causes at most 1 request to Identity per minute.
- **SC-004**: With Identity stopped, Orders starts in the same time as before this story and its
  public endpoints and Kafka processing work; protected requests get `503` until Identity is back,
  then succeed with no restart.
- **SC-005**: After Identity rotates to a new signing key, tokens signed with it are accepted by
  Orders without a restart.
- **SC-006**: No token string appears in any log line or error body produced by the full test
  suite.
- **SC-007**: A route added without an access rule is detected at startup 100% of the time.
- **SC-008**: Every protected operation in the Swagger document shows its required roles and
  the bearer scheme, so a client developer can call it without reading the code.

## Assumptions

- **Health endpoint**: Orders has no health endpoint today. This story adds none; the "public"
  rule covers any added later. The Swagger UI (and its JSON document) is public.
- **GraphQL error style**: authentication failures on GraphQL follow the existing GraphQL error
  convention (an `errors` entry with an extension code, `BAD_USER_INPUT` / `SERVICE_UNAVAILABLE`
  today) rather than an HTTP `401`; the codes are `UNAUTHENTICATED` and `FORBIDDEN`. Only
  operations require a token; the schema is covered too (introspection needs a token).
- **Key cache freshness**: besides the unknown-`kid` refetch requested in the story, the cached
  key set honours the max age Identity sends (Identity's documented verifier guide), so a key
  Identity withdraws stops being accepted without restarting Orders. Fallback: 10 minutes.
- **Required issuer/audience**: like Identity, `JWT_ISSUER` and `JWT_AUDIENCE` have no default
  and are required at startup; `.env.example` gives the local values (`http://localhost:3001`,
  `ecommerce`), matching Identity's `.env.example`.
- **Existing clients and tests**: every REST and GraphQL caller must now send a token. Automated
  tests mint tokens with a test key pair served as a key set; they do not need a running Identity.
- **Order owner**: each order already stores the customer id it was placed for; no data
  migration is needed.
- **Token revocation, refresh, rate limiting at the edge, and GraphQL scoping (US-12)** are out
  of scope. A role change or a disabled user in Identity takes effect in Orders when the token
  expires.
- **Governance**: authentication is a new cross-cutting rule for Orders. The plan decides whether
  it needs a constitution amendment (security principle) and records the design as the next ADR
  (`docs/adr/0008-…`); a new verification library, if any, is justified there.
- **Dependencies**: Identity's token format and key set endpoint as documented in the Identity
  README and constitution (claims exactly as listed above, RS256, `kid` = key thumbprint, several
  keys during rotation).
