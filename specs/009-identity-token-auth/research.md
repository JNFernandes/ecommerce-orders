# Research: Identity Token Auth (US-11)

Each entry: decision, then why. Alternatives only where they were real contenders.

## R1. Library: `jose` ^5.10.0 (dual CJS/ESM)

`jose` 6 is ESM-only and Jest 29 + ts-jest (CJS) cannot load it; 5.10 is the version Identity's
reference verifier uses, so both sides share behaviour. Rejected: `jsonwebtoken` + `jwks-rsa`
(two deps, weaker alg handling), `@nestjs/passport` (strategy layer adds nothing here). Recorded in
ADR 0008 (new runtime dependency, Technology Stack rule).

## R2. Key set: `createRemoteJWKSet` with `cooldownDuration: 60_000`, `cacheMaxAge: 300_000`

Lazy (first `getKey` fetches, never at startup: FR-008, FR-011), concurrent callers share one
pending fetch (US5-7), unknown `kid` triggers at most one refetch per cooldown (FR-009). Built once
per verifier instance; nothing is fetched in a module factory or lifecycle hook (CLAUDE.md rule).

## R3. Cache freshness: fixed 300 s instead of Identity's `Cache-Control`

jose 5.10 has no hook to read response headers, so `max-age` cannot be honoured. 300 s equals
Identity's default `JWKS_CACHE_SECONDS`, so a withdrawn key stops being accepted within 5 min
(stricter than the spec's 10 min fallback). **Spec FR-009 needs a one-line wording fix** (see
plan, Open points). Same with the cooldown: jose counts it from the initial load too, so an
unknown `kid` within 60 s of the first load is rejected without refetch (spec: "first load does
not count"); accepted, harmless in practice.

## R4. Failed refresh keeps loaded keys (FR-010)

jose throws when a stale set's refresh fails, even for a known `kid`. The verifier passes a
`[jwksCache]` object (jose fills it with the last good `jwks` + `uat`); on a fetch failure it
retries verification once with `createLocalJWKSet(cache.jwks)`. No last good set → `KEYS_UNAVAILABLE`.

## R5. Algorithm and header checks

`jwtVerify(token, keySet, { algorithms: ['RS256'], issuer, audience, clockTolerance,
requiredClaims: ['sub', 'exp', 'iat'] })`. The allowlist rejects `none`, HS256 and HS256 signed
with the public key. Before verifying, `decodeProtectedHeader` must show a `kid`: jose would
otherwise pick the only key in the set (FR-002 "never try every key").

## R6. Claims shape and `iat`

After jose: `sub` non-empty string, `roles` string array (unknown roles dropped), `customerId`
absent or UUID (`uuid.validate`, existing dep), `iat <= now + tolerance` (jose only checks `iat`
with `maxTokenAge`). Any break → `INVALID`. Output: frozen `AccessTokenClaims`.

## R7. One typed error: `AccessTokenError { kind: 'INVALID' | 'KEYS_UNAVAILABLE', category }`

Two kinds drive the only two answers (401 / 503); `category` (`missing`, `malformed`, `signature`,
`algorithm`, `claims`, `expired`, `issuer`, `audience`, `unknown-kid`, `fetch`) is for logs only
and never reaches a response. The token string is never put in the error or log.

## R8. Guards as `APP_GUARD`, order `JwtAuthGuard` → `RolesGuard`

Global guards run before pipes, giving the spec's order 401/503 → 403 → 400 → 404/409. They also
apply to resolvers, so one mechanism covers REST and GraphQL. Registered by `AuthModule`, so a
test module that imports it gets the real policy.

## R9. REST answers via `AuthExceptionFilter` (`APP_FILTER`)

Nest exceptions cannot set headers. The guard throws `AccessTokenError`; the filter answers 401
with `WWW-Authenticate: Bearer` and a fixed body, or 503 with a fixed body. Identical bytes for
every failure (FR-005).

## R10. "CUSTOMER" counts only with a `customerId`

`RolesGuard` computes effective roles: `CUSTOMER` without `customerId` is not `CUSTOMER`. This gives
the 403s of US2-4 and US3-6 with no extra code in controllers, and the domain never sees a customer
requester without an id. Admin + customer without id still passes as `ADMIN` on cancel.

## R11. GraphQL: verify in the context factory, reject in a plugin, roles in guards

The context factory (async, injects the verifier) stores `{ req, user, authError }`. An Apollo
plugin (`didResolveOperation`) rejects every operation, including introspection (which no resolver
guards), with `UNAUTHENTICATED` / `SERVICE_UNAVAILABLE` and no data. `RolesGuard` on the resolver
yields `FORBIDDEN`. `JwtAuthGuard` reads the context for GraphQL instead of re-verifying.

## R12. Ownership: domain policy, enforced by the cancel service

Domain gets `OrderRequester { customerId: string | null; isAdmin: boolean }` (no JWT types) and
`order.isAccessibleBy(requester)`. `CancelOrderService` loads the order and throws the same
`NotFoundException('Order not found')` when it is missing or not accessible, then calls
`order.cancel()` unchanged (FR-018, FR-019). Domain stays I/O-free; service only orchestrates.

## R13. Default-deny check: `RoutePolicyValidator` (`onModuleInit`)

`DiscoveryService` + `MetadataScanner` + `Reflector`: every controller handler (has
`PATH_METADATA`) and resolver handler (`RESOLVER_NAME_METADATA`) needs `@Public` or a non-empty
`@Roles` (handler or class). Otherwise throw naming `Class.method`, so `app.init()` fails
(FR-013). Swagger UI is not a Nest route, so it is public without a decorator.

## R14. Config: `auth` section, validated by `AuthModule` factory

`IDENTITY_JWKS_URL` (default `http://localhost:3001/.well-known/jwks.json`),
`JWT_ISSUER`, `JWT_AUDIENCE` (required, no default), `JWT_CLOCK_TOLERANCE_SECONDS` (default 5).
Required values are checked when the verifier provider is built ("JWT_ISSUER is required"), so
`configuration()` stays total and existing config tests are unaffected.

## R15. Test helper: `tests/support/test-identity.ts`

`generateKeyPair('RS256')`, `exportJWK` + thumbprint `kid`, a `node:http` server on
`127.0.0.1:0` serving the set; `sign(claims, { header, key, expiresIn })`, `rotate()`,
`setAvailable(false)` (500), `requestCount`. Sets the four env vars. Shared by unit, integration
and component projects; no running Identity needed.

## R16. Constitution

No principle conflicts (auth sits in the controller/infra boundary; ownership in domain), so no
amendment is required to ship. Rationale goes in ADR 0008; a MINOR amendment adding a security
principle is suggested as follow-up, not a gate.
