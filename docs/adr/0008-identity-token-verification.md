# 0008. Orders verifies Identity access tokens locally

- **Status**: Accepted
- **Date**: 2026-11-23

## Context

Until US-11 every Orders route was open: anyone could place an order for any `customerId`,
cancel or confirm any order and read every order through GraphQL. ecommerce-identity issues
RS256 access tokens (`sub`, optional `customerId`, `roles`, `iss`, `aud`, `exp`, `iat`, header
`kid`) and publishes its public keys as a JWKS at `/.well-known/jwks.json`. Identity can be slow,
down, or rotating its keys. Orders must not depend on it to start, must not call it per request,
and must not tell a caller why a token was rejected (no oracle). The constitution requires
business rules in the domain, a strict layering, and no awaited network calls at startup.

## Decision

We will verify tokens inside Orders with **`jose` 5.10** (`createRemoteJWKSet` + `jwtVerify`).
Not `jose` 6, which is ESM-only and cannot be loaded by our Jest + ts-jest (CJS) setup; 5.10 is
also what Identity's own reference verifier uses. Not `jsonwebtoken` + `jwks-rsa` (two packages,
weaker algorithm handling) and not `@nestjs/passport` (its strategy layer adds nothing here).

Verification (`AccessTokenVerifier`, `src/infra/auth/`):

- Only `RS256`; the header must carry a `kid` (jose would otherwise try the only key it has);
  `iss` = `JWT_ISSUER`, `aud` contains `JWT_AUDIENCE`, `exp`/`iat`/`nbf` with a 5 s tolerance;
  `sub` non-empty, `roles` a string array (unknown roles dropped), `customerId` absent or a UUID.
- The key set is fetched **lazily** on the first request, never at startup or in a module
  factory; concurrent first requests share one fetch (single flight). An unknown `kid` refetches
  at most once per **60 s cooldown**. The set is considered fresh for a **fixed 300 s**: jose
  5.10 cannot read Identity's `Cache-Control`, and 300 s is Identity's default. jose also counts
  the cooldown from the first load, so an unknown `kid` within 60 s of it is rejected without a
  refetch.
- **Last good keys**: when a refresh fails, the verifier retries once with the last set jose
  loaded (`[jwksCache]` + `createLocalJWKSet`), so a known key keeps working while Identity is
  down. Only when no set was ever loaded does the request fail as "keys unavailable".
- One error type, `AccessTokenError`, with `kind` (`INVALID` / `KEYS_UNAVAILABLE`) for the answer
  and `category` for the log line. Tokens are never logged or echoed, not even truncated.

Access control:

- Global guards, registered by `AuthModule` in this order: `JwtAuthGuard` (verify; skip
  `@Public`) then `RolesGuard` (`@Roles`). Guards run before pipes, so the order of answers is
  401/503 → 403 → 400 → 404/409.
- REST answers through `AuthExceptionFilter`: `INVALID` → 401 with `WWW-Authenticate: Bearer` and
  one fixed body for every reason; `KEYS_UNAVAILABLE` → 503.
- **Default deny**: `RoutePolicyValidator` fails startup when a controller route or resolver has
  neither `@Public` nor a non-empty `@Roles` (on the handler or its class), naming each
  `Class.method`.
- **Effective roles**: `CUSTOMER` counts only when the token has a `customerId`.
- **Ownership is a domain rule**: `Order.isAccessibleBy(OrderRequester)` (no JWT types in the
  domain), enforced by `CancelOrderService`. Another customer's order is answered with the same
  404 as a missing order, so a caller cannot probe which order ids exist. `POST /orders` takes the
  customer from the token; a body `customerId` is rejected with 400.
- **GraphQL**: the token is verified once in the Apollo context (`GraphqlContext { user,
  authError }`); an Apollo plugin rejects every operation of a caller without one in
  `didResolveOperation`, introspection included, with `UNAUTHENTICATED` or `SERVICE_UNAVAILABLE`
  and no data (HTTP 200, set via `extensions.http` since Apollo would otherwise answer 500). The
  guards read the caller from the context; `RolesGuard` answers `FORBIDDEN`. Results are not
  scoped to the caller yet (US-12).

## Consequences

- Orders starts and runs its Kafka consumers whether or not Identity is reachable; protected
  requests get 503 only until the first successful fetch, then keep working through Identity
  outages and key rotations without a restart.
- A withdrawn key stops being accepted within 5 minutes (the fixed cache age), not at Identity's
  `max-age`. If Identity ever needs faster revocation, Orders needs a newer jose or its own fetch.
- Every new route or resolver must declare `@Public()` or `@Roles(...)`, or the service will not
  start. Handlers read the caller only through `@CurrentUser()`.
- Tests mint their own tokens with `tests/support/test-identity.ts` (a local JWKS server); no
  running Identity is needed.
- `JWT_ISSUER` and `JWT_AUDIENCE` are required; the service refuses to start without them.
- A GraphQL request that fails schema validation is answered with the validation error before
  the auth plugin runs, so an anonymous caller can still see validation messages. Introspection
  and data stay closed to them.
- The read path is closed to anonymous callers but not scoped per customer: any `CUSTOMER` can
  read every order until US-12 adds scoping.
- Follow-up: a MINOR constitution amendment adding a security principle (token verification,
  default deny, no token in logs), suggested in research R16. It does not block this story.
