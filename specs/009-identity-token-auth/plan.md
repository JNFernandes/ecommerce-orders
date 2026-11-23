# Implementation Plan: Identity Token Auth and Order Ownership (US-11)

**Branch**: `feature/US-11-identity-token-auth` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

## Summary

Verify Identity access tokens locally with `jose` (`createRemoteJWKSet`, RS256, `iss`/`aud`/
tolerance from config) in an `AccessTokenVerifier` that returns typed claims or one
`AccessTokenError`. Global `JwtAuthGuard` + `RolesGuard` (`APP_GUARD`), `@Public` / `@Roles` /
`@CurrentUser`, and a startup check that every REST and GraphQL handler has a rule. `POST /orders`
takes `customerId` from the token; cancel checks ownership through a domain predicate in the
service (404 otherwise); confirm is ADMIN-only. GraphQL verifies in its context and rejects
unauthenticated operations. Decisions: [research.md](research.md).

## Technical Context

- **Stack**: NestJS 10, TypeScript strict, `@nestjs/cqrs`, Apollo GraphQL, + `jose` ^5.10.0 (R1)
- **Storage**: none new; no migration (orders already store `customerId`)
- **Tests**: Jest; unit, integration (Postgres/Mongo testcontainers), component; tokens from
  `tests/support/test-identity.ts` (R15)
- **Constraints**: no key fetch at startup; Kafka consumers, projection, dead-letter worker untouched
- **Performance**: 0 Identity calls with keys loaded; ≤ 1 refetch/min for unknown `kid`
- No open NEEDS CLARIFICATION.

## Constitution Check

| Principle | Status |
|---|---|
| I DDD / layering | ✅ Ownership is `Order.isAccessibleBy(requester)` in domain; service loads + throws 404; guards/controller do I/O and role metadata only |
| II CQRS | ✅ resolvers still only dispatch queries; auth adds no read/write mixing |
| III Write flow | ✅ unchanged save-then-publish; rejected requests save and publish nothing |
| IV Type safety / validation | ✅ typed claims, `PlaceOrderDto` keeps `forbidNonWhitelisted`; errors via Nest exceptions + filter; no `any` |
| V/VI Tests | ✅ unit (verifier, guards, policy, domain, services), integration + component (below) |
| VII Kafka | ✅ consumers/producer unchanged, no token involved |
| VIII Branching | ✅ `feature/US-11-identity-token-auth` |
| IX Quality gate | ✅ build, lint, format, test before each commit |
| Tech stack: new dep | ✅ `jose` duplicates nothing in the stack; justified in ADR 0008 |

Post-design re-check: no violations. No constitution amendment needed to ship (R16).

## Project Structure

```text
src/infra/auth/role.enum.ts                         new: Role
src/infra/auth/access-token-claims.ts               new: AccessTokenClaims
src/infra/auth/access-token.error.ts                new: AccessTokenError (kind, category)
src/infra/auth/access-token.verifier.ts             new: jose verifier (R2-R6), JSDoc
src/infra/auth/auth.module.ts                       new: verifier factory (config check R14), APP_GUARDs, APP_FILTER, RoutePolicyValidator
src/controllers/auth/public.decorator.ts            new: @Public
src/controllers/auth/roles.decorator.ts             new: @Roles
src/controllers/auth/current-user.decorator.ts      new: @CurrentUser (HTTP + GraphQL)
src/controllers/auth/jwt-auth.guard.ts              new: skip @Public; HTTP verify / GraphQL read context
src/controllers/auth/roles.guard.ts                 new: effective roles (R10); FORBIDDEN on GraphQL
src/controllers/auth/auth-exception.filter.ts       new: 401 + WWW-Authenticate / 503 fixed bodies (R9)
src/controllers/auth/route-policy.validator.ts      new: startup default-deny check (R13)
src/controllers/auth/bearer-token.ts                new: parse `Authorization: Bearer`
src/controllers/orders.controller.ts                @Roles per route, @ApiBearerAuth, 401/403/503 docs, claims → command
src/controllers/orders.resolver.ts                  @Roles(CUSTOMER, ADMIN) at class level
src/dto/place-order.dto.ts                          remove customerId
src/domain/order-requester.ts                       new: OrderRequester
src/domain/order.aggregate.ts                       + isAccessibleBy(requester)
src/commands/cancel-order.command.ts                + requester
src/services/cancel-order.service.ts                404 when missing or not accessible
src/graphql/graphql-context.ts                      new: GraphqlContext
src/graphql/graphql-auth.plugin.ts                  new: reject unauthenticated operations (R11)
src/graphql/graphql.config.ts                       async context (verifier), plugin
src/app.module.ts                                   import AuthModule; GraphQL forRootAsync injects verifier
src/app.swagger.ts                                  new: buildSwaggerDocument (addBearerAuth), used by main.ts and tests
src/main.ts                                         use buildSwaggerDocument
src/config/configuration.ts, .env.example           + auth section (4 vars)
tests/support/test-identity.ts                      new: key pair, sign, JWKS server, rotate, availability, request count
docs/adr/0008-identity-token-verification.md, docs/adr/README.md, README.md, CLAUDE.md, src/README.md
```

## Tests

- **Unit, verifier** (with `test-identity`): valid → claims; expired beyond tolerance; expired
  within tolerance accepted; wrong signature; `alg: none`; HS256; HS256 with the public key PEM as
  secret; no `kid`; unknown `kid` (refetch once, then cooldown: no second fetch); rotation accepted
  after refetch; wrong issuer; wrong audience; `aud` array containing ours; future `iat`/`nbf`;
  bad claim shapes (no `sub`, `roles` not strings, non-UUID `customerId`); keys unavailable with
  none loaded → `KEYS_UNAVAILABLE`; refresh fails with keys loaded → still valid (R4); 20
  concurrent first calls → 1 fetch; error message never contains the token.
- **Unit, guards/filter/decorators**: `JwtAuthGuard` skips `@Public`, missing/non-Bearer header,
  attaches claims, GraphQL path reads context; `RolesGuard` allow/deny, CUSTOMER without
  `customerId`, both roles, empty/unknown roles; filter bodies and header identical across
  categories; `@CurrentUser` HTTP and GraphQL.
- **Unit, route policy**: fixture controller/resolver missing a rule → `init()` rejects naming
  `Class.method`; `@Public` and `@Roles` pass; the real `AppModule` controllers/resolvers all pass.
- **Unit, domain/services**: `isAccessibleBy` (owner, other, admin, null customerId);
  `CancelOrderService` other customer → `NotFoundException`, nothing saved/published; admin
  cancels any; `PlaceOrderService` unchanged; config defaults and auth module error naming
  `JWT_ISSUER` / `JWT_AUDIENCE`; Swagger document has bearer scheme, roles and 401/403/503.
- **Integration** (existing API specs updated to import `AuthModule` and send tokens): place,
  cancel, confirm, list-orders GraphQL, CORS (preflight still public).
- **Component**: place order as customer uses token `customerId` (DB row + Kafka event); body with
  `customerId` → 400; admin token without `customerId` → 403 on `POST /orders`; cancel own order →
  200; another customer's order → 404 equal to random id; admin cancels any; confirm 403 for
  customer, 200 for admin; GraphQL without token → `UNAUTHENTICATED`, with token → data; Swagger
  `/api-json` public; no token substring in captured logs (Logger spy + stdout/stderr capture)
  across the 401/403/503 runs. All existing component specs that call the API send tokens.

## Docs

README: auth section (getting a token, header, per-route rules, 401/403/404/503, GraphQL not
scoped until US-12), env vars. `.env.example`: the four vars with local values. ADR 0008 (jose,
lazy JWKS, default deny, ownership as 404) + index. CLAUDE.md: auth rules and env. `src/README.md`.

## Open points (for /speckit-tasks or a spec touch-up)

1. FR-009 says "honour Identity's max-age, fallback 10 min" and "first load does not count" for
   the cooldown; with jose 5.10 the plan uses a fixed 300 s max age and a cooldown that also
   follows the first load (R3). Update the spec wording or accept as documented in ADR 0008.
2. "Health stays public": Orders has no health endpoint and the spec adds none, so the component
   test covers Swagger (`/api`, `/api-json`) and the route-policy test covers a `@Public` fixture.

## Complexity Tracking

None.
