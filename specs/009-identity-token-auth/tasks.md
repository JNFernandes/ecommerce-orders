---

description: "Task list for US-11: Identity token auth and order ownership"
---

# Tasks: Identity Token Auth and Order Ownership (US-11)

**Input**: Design documents from `specs/009-identity-token-auth/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R16), data-model.md, contracts/rest-auth.md,
contracts/graphql-auth.md, quickstart.md

**Tests**: Included. The constitution (Principles V/VI) and plan.md "Tests" require unit,
integration and component coverage for this story.

**Organization**: Tasks are grouped by user story (spec.md US1–US7) so each story can be
implemented and tested on its own. Spec stories map to labels `[US1]`…`[US7]`.

**Branch**: `feature/US-11-identity-token-auth` (already created). Commit per task group with
Conventional Commits scoped `US-11` (`feat(US-11): …`, `test(US-11): …`, `docs(US-11): …`).
Run the quality gate (`npm run build`, `npm run lint`, `npm run format:check`, `npm run test`)
before every commit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: User story label (US1–US7); Setup, Foundational and Polish tasks have none

## Path Conventions

Single NestJS project: `src/`, `tests/unit/`, `tests/integration/`, `tests/component/`, shared test
helpers in `tests/support/` (new folder, used by all three Jest projects).

## Cross-cutting design notes (read before any task)

- Guards are global (`APP_GUARD`), order `JwtAuthGuard` → `RolesGuard` (R8), so the check order is
  401/503 → 403 → 400 (pipes) → 404/409 (services).
- `RolesGuard` uses **effective roles** (R10): `CUSTOMER` counts only when `customerId` is present.
  A handler with no `@Roles` metadata is allowed by `RolesGuard`; default deny is enforced at
  startup by `RoutePolicyValidator` (US6).
- Until US7, `JwtAuthGuard` and `RolesGuard` act only on `context.getType() === 'http'`;
  GraphQL contexts pass through unchanged (today's behaviour). US7 adds the GraphQL branch.
- Tokens never appear in an error message, a log line or a response body (FR-007). Log the
  `AccessTokenError.category` only.
- Nothing fetches the JWKS at startup or in a module factory / lifecycle hook (FR-008, CLAUDE.md).
- No `any`. JSDoc on every new public class and method.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependency, configuration and the test identity helper every later phase uses.

- [X] T001 Add `jose` `^5.10.0` (not 6.x: ESM-only, breaks ts-jest CJS, R1) to `dependencies` in `package.json` with `npm install jose@^5.10.0`; confirm `npm run build` and `npm run test:unit` still pass
- [X] T002 [P] Add an `auth` section to `src/config/configuration.ts` (`jwksUrl` from `IDENTITY_JWKS_URL`, default `http://localhost:3001/.well-known/jwks.json`; `issuer` from `JWT_ISSUER`, `audience` from `JWT_AUDIENCE`, both `string | undefined` with no default; `clockToleranceSeconds` from `JWT_CLOCK_TOLERANCE_SECONDS`, default `5`), typed with an exported `AuthConfig` interface; `configuration()` must stay total (no throw, R14)
- [X] T003 [P] Extend `tests/unit/config/configuration.spec.ts`: defaults for `auth.jwksUrl` and `auth.clockToleranceSeconds`, env overrides for all four vars, `issuer`/`audience` `undefined` when unset
- [X] T004 [P] Add the four vars to `.env.example` with local values `IDENTITY_JWKS_URL=http://localhost:3001/.well-known/jwks.json`, `JWT_ISSUER=http://localhost:3001`, `JWT_AUDIENCE=ecommerce`, `JWT_CLOCK_TOLERANCE_SECONDS=5`, each with a one-line comment
- [X] T005 Create `tests/support/test-identity.ts` (R15): class `TestIdentity` with `static start(): Promise<TestIdentity>` (RS256 `generateKeyPair`, `exportJWK`, `kid` = `calculateJwkThumbprint`, a `node:http` server on `127.0.0.1:0` serving `{ keys: [...] }` at `/.well-known/jwks.json`), `jwksUrl`, `issuer` (`http://test-identity`), `audience` (`ecommerce`), `sign(claims, options?)` (options: `header` overrides incl. `kid`/`alg`, `key`, `expiresIn`, `iat`, `nbf`, `issuer`, `audience`; defaults `sub` = random UUID, `roles`, `iat` now, `exp` now + 15 min), helpers `customerToken(customerId)`, `adminToken()`, `customerAdminToken(customerId)`, `rotate()` (new key pair, new kid; served set contains old + new), `removeKey(kid)`, `setAvailable(boolean)` (false → HTTP 500), `requestCount` getter, `applyEnv()` (sets `IDENTITY_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_CLOCK_TOLERANCE_SECONDS`), `stop()`; plus `signHs256(secret, claims)` and `unsignedToken(claims)` (`alg: none`) builders for negative tests. JSDoc on every export

**Checkpoint**: `jose` installed, config readable, tokens can be minted in tests without Identity.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Types, decorators and the roles guard that every user story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 [P] Create `src/infra/auth/role.enum.ts`: `enum Role { CUSTOMER = 'CUSTOMER', ADMIN = 'ADMIN' }` and `parseRoles(values: readonly string[]): readonly Role[]` that drops unknown strings (data-model "Role")
- [X] T007 [P] Create `src/infra/auth/access-token-claims.ts`: `interface AccessTokenClaims { readonly sub: string; readonly customerId?: string; readonly roles: readonly Role[] }` and `effectiveRoles(claims): readonly Role[]` (drops `CUSTOMER` when `customerId` is absent, R10)
- [X] T008 [P] Create `src/infra/auth/access-token.error.ts`: `AccessTokenErrorKind = 'INVALID' | 'KEYS_UNAVAILABLE'`, `AccessTokenErrorCategory` union (`missing`, `malformed`, `algorithm`, `signature`, `unknown-kid`, `issuer`, `audience`, `expired`, `claims`, `fetch`), `class AccessTokenError extends Error { kind; category }` with a fixed message per kind that never contains token text (R7)
- [X] T009 [P] Create `src/controllers/auth/public.decorator.ts` (`IS_PUBLIC_KEY`, `@Public()` via `SetMetadata`) and `src/controllers/auth/roles.decorator.ts` (`ROLES_KEY`, `@Roles(...roles: [Role, ...Role[]])`, non-empty tuple type)
- [X] T010 [P] Create `src/controllers/auth/bearer-token.ts`: `extractBearerToken(header: string | string[] | undefined): string | null`, case-insensitive `Bearer` scheme, exactly one space-separated token, returns `null` for anything else
- [X] T011 [P] Create `src/controllers/auth/current-user.decorator.ts`: `@CurrentUser()` param decorator returning `AccessTokenClaims` from `request.user` for HTTP contexts (GraphQL branch added in T068); throws `InternalServerErrorException` if absent (guard should have run)
- [X] T012 Create `src/controllers/auth/roles.guard.ts`: `RolesGuard implements CanActivate`; reads `ROLES_KEY` from handler then class with `Reflector.getAllAndOverride`; `@Public` or no roles metadata → allow; HTTP only (non-http types → allow until T066); allow when `effectiveRoles(request.user)` intersects the route roles, else throw `ForbiddenException()` (Nest default body, contracts/rest-auth.md)
- [X] T013 [P] Unit tests `tests/unit/controllers/auth/roles.guard.spec.ts`: allow/deny per role; `CUSTOMER` without `customerId` denied on `@Roles(CUSTOMER)`; `CUSTOMER`+`ADMIN` without `customerId` allowed on `@Roles(CUSTOMER, ADMIN)`; empty roles and unknown-only roles denied; `@Public` and no-metadata allowed; class-level `@Roles` honoured
- [X] T014 [P] Unit tests `tests/unit/controllers/auth/bearer-token.spec.ts` (missing, `Basic x`, `Bearer` with no token, extra parts, lowercase `bearer`, array header) and `tests/unit/infra/auth/access-token-claims.spec.ts` (`parseRoles`, `effectiveRoles`)

**Checkpoint**: Foundation ready; user stories can start.

---

## Phase 3: User Story 1 - Only callers with a valid Identity token get in (Priority: P1) 🎯 MVP

**Goal**: Every REST route requires a valid Identity access token verified locally; every failure
gets the identical `401` with `WWW-Authenticate: Bearer`; keys unavailable → `503`.

**Independent Test**: With `TestIdentity` serving keys, each failure case of spec US1 scenario 2
gets byte-identical `401` (status, header, body `{"statusCode":401,"message":"Unauthorized"}`); a
valid token reaches the endpoint; `GET /api-json` answers without a token.

### Tests for User Story 1

- [X] T015 [P] [US1] Unit tests `tests/unit/infra/auth/access-token.verifier.spec.ts` using `TestIdentity`: valid → frozen claims (`sub`, `customerId`, known `roles` only); expired beyond tolerance → `INVALID/expired`; expired within 5 s accepted; tampered payload → `signature`; `alg: none` and HS256 (random secret and the public key PEM as secret) → `algorithm`; no `kid` → `INVALID` even with a one-key set; unknown `kid` → `unknown-kid`; wrong `iss`; wrong `aud`; `aud` array containing ours accepted; future `iat` / `nbf` beyond tolerance → `INVALID`; no `sub`, `roles` not string array, non-UUID `customerId` → `claims`; garbage string → `malformed`; no error message contains the token or its first 20 characters
- [X] T016 [P] [US1] Unit tests `tests/unit/controllers/auth/jwt-auth.guard.spec.ts`: `@Public` handler skipped without calling the verifier; missing/non-Bearer header → `AccessTokenError(INVALID, missing)`; verifier error propagated; success attaches claims to `request.user`; non-http context passes through (until US7)
- [X] T017 [P] [US1] Unit tests `tests/unit/controllers/auth/auth-exception.filter.spec.ts`: `INVALID` of every category → status 401, header `WWW-Authenticate: Bearer`, body exactly `{"statusCode":401,"message":"Unauthorized"}`; `KEYS_UNAVAILABLE` → 503 body exactly `{"statusCode":503,"message":"Service Unavailable"}`; one log line with the category only
- [X] T018 [P] [US1] Unit test `tests/unit/infra/auth/auth.module.spec.ts`: compiling `AuthModule` without `JWT_ISSUER` fails with an error message naming `JWT_ISSUER`; same for `JWT_AUDIENCE`; with both set, compiles and the verifier made no JWKS request (`TestIdentity.requestCount === 0`)

### Implementation for User Story 1

- [X] T019 [US1] Create `src/infra/auth/access-token.verifier.ts`: injectable `AccessTokenVerifier` built from `AuthConfig`; one `createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 60_000, cacheMaxAge: 300_000 })` per instance, created lazily-safe (jose fetches on first `getKey`, R2); `verify(token: string): Promise<AccessTokenClaims>`: `decodeProtectedHeader` must succeed and carry a string `kid` (else `malformed`/`signature`), then `jwtVerify(token, keySet, { algorithms: ['RS256'], issuer, audience, clockTolerance, requiredClaims: ['sub', 'exp', 'iat'] })` (R5); map jose errors to `AccessTokenError` categories (`JWTExpired` → expired, `JWTClaimValidationFailed` iss/aud → issuer/audience, `JOSEAlgNotAllowed` → algorithm, `JWSSignatureVerificationFailed` → signature, `JWKSNoMatchingKey` → unknown-kid, `JWKSTimeout`/fetch failures → `KEYS_UNAVAILABLE/fetch`); then shape checks of R6 (`sub` non-empty, `roles` string array → `parseRoles`, `customerId` absent or `uuid.validate`, `iat <= now + tolerance`); return `Object.freeze`d claims; JSDoc
- [X] T020 [US1] Create `src/controllers/auth/jwt-auth.guard.ts`: `JwtAuthGuard implements CanActivate`; skip when `IS_PUBLIC_KEY` is set (handler or class); for HTTP read `Authorization` via `extractBearerToken`, missing → throw `AccessTokenError('INVALID', 'missing')`, else `await verifier.verify(token)` and set `request.user`; non-http → return `true` (until T066); add a `user?: AccessTokenClaims` augmentation for Express `Request` in `src/controllers/auth/request-user.ts`
- [X] T021 [US1] Create `src/controllers/auth/auth-exception.filter.ts`: `@Catch(AccessTokenError)` filter for HTTP contexts writing the fixed 401 (with `WWW-Authenticate: Bearer`) / 503 bodies from contracts/rest-auth.md; logs `Rejected request: <category>` with Nest `Logger` (never the token); for non-http contexts rethrow (GraphQL handled in US7)
- [X] T022 [US1] Create `src/infra/auth/auth.module.ts`: provider `AccessTokenVerifier` via factory reading `auth` config, throwing `Error('JWT_ISSUER is required')` / `Error('JWT_AUDIENCE is required')` when unset (R14), no network call; `APP_GUARD` `JwtAuthGuard` then `APP_GUARD` `RolesGuard` (registration order = execution order); `APP_FILTER` `AuthExceptionFilter`; exports `AccessTokenVerifier`; JSDoc
- [X] T023 [US1] Import `AuthModule` in `src/app.module.ts`
- [X] T024 [US1] Create `tests/support/auth-testing.ts`: `withTestIdentity()` Jest helper (starts `TestIdentity` in `beforeAll`, calls `applyEnv()` before the Nest module is compiled, stops in `afterAll`) and `bearer(token)` → `{ Authorization: 'Bearer …' }`
- [X] T025 [US1] Update the REST-calling integration specs to start `TestIdentity`, import `AuthModule` in their test module (if not built from `AppModule`) and send `customerToken(<seeded customerId>)` (cancel/confirm: `customerAdminToken` for now; narrowed in US3/US4): `tests/integration/place-order.integration.spec.ts`, `tests/integration/cancel-order.integration.spec.ts`, `tests/integration/confirm-order.integration.spec.ts`, `tests/integration/cors.integration.spec.ts` (preflight `OPTIONS` stays tokenless and must still pass), `tests/integration/apply-payment-outcome.integration.spec.ts` and `tests/integration/inventory-events.integration.spec.ts` (only where they call REST)
- [X] T026 [US1] Update the REST-calling component specs the same way: `tests/component/place-order.component.spec.ts`, `cancel-order.component.spec.ts`, `confirm-order.component.spec.ts`, `customer-registration.component.spec.ts`, `dead-letter-retry.component.spec.ts`, `kafka-unavailable.component.spec.ts`, `order-outcomes.component.spec.ts`, `order-projection.component.spec.ts`, `react-to-payment-outcome.component.spec.ts` (all under `tests/component/`); GraphQL calls in them stay tokenless until US7
- [X] T027 [US1] Integration test `tests/integration/auth-rest.integration.spec.ts` (full `AppModule` HTTP app, `TestIdentity`): against `POST /orders/{random uuid}/cancel` the cases no header, `Basic x`, `Bearer garbage`, tampered signature, unknown key, `alg: none`, HS256, HS256 with public key PEM, wrong `iss`, wrong `aud`, expired by 10 s, no `kid` all return byte-identical status, `WWW-Authenticate` and body (SC-001); expired by 2 s accepted (reaches the 404); no token + invalid body on `POST /orders` → 401 not 400; `GET /api-json` → 200 without a token (Swagger setup via the same code as `main.ts`, refactor in T055 if needed)

**Checkpoint**: All REST routes require a valid token; MVP shippable.

---

## Phase 4: User Story 2 - Customers place orders only for themselves (Priority: P1)

**Goal**: `POST /orders` is `CUSTOMER`-only and takes `customerId` from the token; a body with
`customerId` is `400`.

**Independent Test**: CUSTOMER token for `C`, body with only `items` → `201`, DB row and
`orders.order-placed` carry `C`; adding `customerId` → `400`; ADMIN-only token or CUSTOMER without
`customerId` → `403`.

### Tests for User Story 2

- [X] T028 [P] [US2] Update `tests/unit/services/place-order.service.spec.ts` only if the command shape changed (it must not: `PlaceOrderCommand(customerId, items)` stays, data-model "Command changes"); add a unit test `tests/unit/dto/place-order.dto.spec.ts` asserting validation with `forbidNonWhitelisted` rejects a body with `customerId` and accepts `{ items }`
- [X] T029 [P] [US2] Update `tests/integration/place-order.integration.spec.ts`: bodies hold only `items`; saved order and published event use the token's `customerId`; body with `customerId` (same and other value) → `400`, nothing saved/published; ADMIN-only → `403`; CUSTOMER without `customerId` → `403`; CUSTOMER+ADMIN → created for own `customerId`; customer not yet created → `404 Customer not found`
- [X] T030 [P] [US2] Update `tests/component/place-order.component.spec.ts` (and drop `customerId` from bodies in every other spec under `tests/component/` and `tests/integration/` that places orders): order row and `orders.order-placed` event carry the token's `customerId`; body with `customerId` → `400`; ADMIN-only token → `403`

### Implementation for User Story 2

- [X] T031 [US2] Remove `customerId` (property, validators and `@ApiProperty`) from `src/dto/place-order.dto.ts`; keep `items` unchanged; update the class JSDoc to say the customer comes from the token
- [X] T032 [US2] In `src/controllers/orders.controller.ts` `placeOrder`: add `@Roles(Role.CUSTOMER)`, inject `@CurrentUser() user: AccessTokenClaims`, dispatch `new PlaceOrderCommand(user.customerId, dto.items)` (narrow `customerId` with a guard clause throwing `ForbiddenException` if absent: unreachable after `RolesGuard`, keeps types strict without `!`)
- [X] T033 [US2] Update the request example in `src/README.md` / any `.http` or Swagger example in the repo that still sends `customerId` in the place-order body (grep `customerId` under `docs/` and `src/`)

**Checkpoint**: Customers can only order for themselves.

---

## Phase 5: User Story 3 - Customers cancel only their own orders; admins can cancel any (Priority: P1)

**Goal**: Ownership decided in the domain (`Order.isAccessibleBy`), enforced by `CancelOrderService`
with the same `404` as a missing order.

**Independent Test**: Order of `A`; `B` cancels → `404` identical to a random id, order still
`PENDING`, nothing published; `A` cancels → `200 CANCELLED`; admin cancels another `A` order → `200`.

### Tests for User Story 3

- [X] T034 [P] [US3] Extend `tests/unit/domain/order.aggregate.spec.ts`: `isAccessibleBy` true for owner, false for other customer, true for admin (any `customerId`, including `null`), false for `{ customerId: null, isAdmin: false }`
- [X] T035 [P] [US3] Update `tests/unit/services/cancel-order.service.spec.ts`: other customer → `NotFoundException('Order not found')` with the same message as a missing order, no save, no publish; owner cancels; admin cancels any; non-`PENDING` owner → existing conflict error
- [X] T036 [P] [US3] Update `tests/integration/cancel-order.integration.spec.ts` and `tests/component/cancel-order.component.spec.ts`: other customer's order → `404` with body byte-equal to a random UUID's `404`, order still `PENDING`, no `orders.order-cancelled` event; owner → `200 CANCELLED`; ADMIN-only and CUSTOMER+ADMIN on another customer's order → `200`; non-`PENDING` → `409`; CUSTOMER without `customerId` → `403`; unknown-roles token → `403`

### Implementation for User Story 3

- [X] T037 [P] [US3] Create `src/domain/order-requester.ts`: `interface OrderRequester { readonly customerId: string | null; readonly isAdmin: boolean }` (no JWT types, R12); JSDoc
- [X] T038 [US3] Add `isAccessibleBy(requester: OrderRequester): boolean` to `src/domain/order.aggregate.ts` (`requester.isAdmin || requester.customerId === this.customerId`); JSDoc
- [X] T039 [US3] Add `readonly requester: OrderRequester` to `src/commands/cancel-order.command.ts` (`constructor(orderId, requester)`)
- [X] T040 [US3] In `src/services/cancel-order.service.ts`: after loading, throw the same `NotFoundException('Order not found')` when the order is missing **or** `!order.isAccessibleBy(command.requester)`; rest (cancel, save, publish) unchanged
- [X] T041 [US3] In `src/controllers/orders.controller.ts` `cancelOrder`: add `@Roles(Role.CUSTOMER, Role.ADMIN)`, `@CurrentUser()`, build `OrderRequester` from effective roles (`customerId` only if `CUSTOMER` is effective, `isAdmin` = has `ADMIN`) and pass it in `CancelOrderCommand`; map nothing new (existing 404/409 mapping stays)

**Checkpoint**: Cancellation respects ownership.

---

## Phase 6: User Story 4 - Only admins can confirm an order by hand (Priority: P1)

**Goal**: `POST /orders/:orderId/confirm` is `ADMIN`-only.

**Independent Test**: CUSTOMER token → `403`, order unchanged, nothing published; ADMIN → `200 CONFIRMED`.

- [X] T042 [P] [US4] Update `tests/integration/confirm-order.integration.spec.ts` and `tests/component/confirm-order.component.spec.ts`: CUSTOMER token → `403`, order still `PENDING`, no `orders.order-confirmed`; ADMIN → `200 CONFIRMED`; ADMIN on unknown id → `404`, on non-`PENDING` → `409`
- [X] T043 [US4] In `src/controllers/orders.controller.ts` `confirmOrder`: add `@Roles(Role.ADMIN)`; `ConfirmOrderCommand` unchanged
- [X] T044 [US4] Switch any other spec that confirms through REST (e.g. `tests/component/order-projection.component.spec.ts`, `tests/component/dead-letter-retry.component.spec.ts`) to `adminToken()`

**Checkpoint**: All P1 stories done; REST access rules complete.

---

## Phase 7: User Story 5 - Orders keeps working when Identity is slow, down or rotating keys (Priority: P2)

**Goal**: Lazy single-flight key fetch, ≤ 1 refetch/min for unknown `kid`, loaded keys survive a
failed refresh, `503` only when no keys were ever loaded, startup independent of Identity.

**Independent Test**: Orders starts with `TestIdentity` unavailable; `/api-json` 200; protected
request 503; make it available → next request succeeds; 100 valid requests → 1 fetch; `rotate()`
→ new-key token accepted; burst of random `kid`s → ≤ 1 fetch per minute.

### Tests for User Story 5

- [X] T045 [P] [US5] Extend `tests/unit/infra/auth/access-token.verifier.spec.ts`: 20 concurrent first `verify` calls → `requestCount === 1`; 100 sequential valid calls → 1 fetch; unavailable with nothing loaded → `KEYS_UNAVAILABLE/fetch`; then available → success without a new verifier; `rotate()` and token with the new `kid` after the cooldown → accepted (fake timers or a verifier built with an injectable clock / cooldown override); 50 random unknown `kid`s inside the cooldown → at most 1 refetch; keys loaded, cache stale (advance past 300 s), `setAvailable(false)` → known-kid token still accepted (R4); `removeKey(kid)` then refresh after 300 s → that token rejected `INVALID`
- [X] T046 [P] [US5] Component test `tests/component/identity-unavailable.component.spec.ts`: boot the full app with `TestIdentity.setAvailable(false)`; startup time not blocked (init resolves with `requestCount === 0`); `GET /api-json` 200; Kafka consumer still processes an `identity.user-registered` event (customer row created); `POST /orders` with a valid token → `503` with the exact body; `setAvailable(true)` → same request `201` without restart; captured logs contain no token substring

### Implementation for User Story 5

- [X] T047 [US5] In `src/infra/auth/access-token.verifier.ts` add the last-good fallback (R4): keep a `jwksCache: { jwks?, uat? }` object passed to `createRemoteJWKSet` via jose's `[jwksCache]` symbol export; on a fetch-category failure, if `cache.jwks` exists retry once with `createLocalJWKSet(cache.jwks)`, else throw `AccessTokenError('KEYS_UNAVAILABLE', 'fetch')`; non-JSON body, HTTP error and a set with no usable RS256 key all count as fetch failures (spec edge case)
- [X] T048 [US5] Make the verifier's timing testable without exposing it in production config: optional constructor options `{ cooldownMs?: number; cacheMaxAgeMs?: number }` defaulting to `60_000` / `300_000`, used only by tests (JSDoc says so); verify `AuthModule` passes none
- [X] T049 [US5] Confirm no code path calls the verifier or fetches the JWKS during `app.init()` (search `onModuleInit`/`onApplicationBootstrap`/factories in `src/infra/auth/` and `src/graphql/`); `TestIdentity.requestCount === 0` after init is asserted in T046

**Checkpoint**: Identity outages and key rotation handled without restarts.

---

## Phase 8: User Story 6 - Every route has an explicit access rule, visible in the API docs (Priority: P2)

**Goal**: Default deny at startup; Swagger shows the bearer scheme, roles and 401/403/503 per operation.

**Independent Test**: A fixture controller with an unannotated handler makes `app.init()` reject
naming `Class.method`; the real `AppModule` boots; `/api-json` has `components.securitySchemes.bearer`
and every protected operation references it, lists roles and documents 401/403/503.

### Tests for User Story 6

- [X] T050 [P] [US6] Unit tests `tests/unit/controllers/auth/route-policy.validator.spec.ts`: fixture controller with an unannotated route → `init()` rejects with a message containing `FixtureController.handler`; fixture resolver with an unannotated `@Query` → rejects naming it; `@Public()` handler, method-level `@Roles` and class-level `@Roles` pass; empty `@Roles` metadata (forced via `SetMetadata`) rejected; the real `AppModule` compiles and inits (with `TestIdentity` env)
- [X] T051 [P] [US6] Unit test `tests/unit/app.swagger.spec.ts`: `buildSwaggerDocument(app)` declares a bearer JWT scheme; `POST /orders`, cancel and confirm each have `security: [{ bearer: [] }]`, a description naming their roles (`CUSTOMER`; `CUSTOMER` (own orders) or `ADMIN` (any order); `ADMIN`), and `401`, `403`, `503` responses; place-order request schema has no `customerId` property; the document contains no token-like string

### Implementation for User Story 6

- [X] T052 [US6] Create `src/controllers/auth/route-policy.validator.ts`: `RoutePolicyValidator implements OnModuleInit` using `DiscoveryService`, `MetadataScanner`, `Reflector`; for every controller (`PATH_METADATA` on class) and resolver (`RESOLVER_NAME_METADATA` / `RESOLVER_TYPE_METADATA` from `@nestjs/graphql`) method that is a route handler / resolver field, require `IS_PUBLIC_KEY` or a non-empty `ROLES_KEY` on handler or class; collect all offenders and throw one `Error` listing each as `Class.method` (R13); JSDoc
- [X] T053 [US6] Register `RoutePolicyValidator` and import `DiscoveryModule` in `src/infra/auth/auth.module.ts`
- [X] T054 [US6] Create `src/app.swagger.ts`: `buildSwaggerDocument(app: INestApplication): OpenAPIObject` (`DocumentBuilder` with the existing title/description/version from `main.ts` + `.addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')`) and `setupSwagger(app)` mounting it at `api`; JSDoc
- [X] T055 [US6] Use `setupSwagger(app)` in `src/main.ts` (remove the inline `DocumentBuilder`), and in `tests/integration/auth-rest.integration.spec.ts` / component specs that assert `/api-json`
- [X] T056 [US6] In `src/controllers/orders.controller.ts` add `@ApiBearerAuth('bearer')` (class level), extend each operation's `@ApiOperation({ description })` with its roles as in T051, and add `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiServiceUnavailableResponse` with the exact bodies from contracts/rest-auth.md

**Checkpoint**: No route can be added open by accident; docs show how to call each operation.

---

## Phase 9: User Story 7 - GraphQL requires a token (not yet scoped) (Priority: P2)

**Goal**: Every GraphQL operation (introspection included) needs a valid token with `CUSTOMER` or
`ADMIN`; failures return no data and `UNAUTHENTICATED` / `FORBIDDEN` / `SERVICE_UNAVAILABLE`.

**Independent Test**: `orders` and `order(orderId)` without token → `UNAUTHENTICATED`, no `data`;
introspection without token → `UNAUTHENTICATED`; token with unknown roles only → `FORBIDDEN`;
keys unavailable → `SERVICE_UNAVAILABLE`; CUSTOMER or ADMIN → same results as today.

### Tests for User Story 7

- [ ] T057 [P] [US7] Unit tests `tests/unit/graphql/graphql-auth.plugin.spec.ts`: `didResolveOperation` with `authError` `INVALID` → `GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } })`; `KEYS_UNAVAILABLE` → message `Authentication is temporarily unavailable, please retry`, code `SERVICE_UNAVAILABLE`; no user and no error (missing header) → `UNAUTHENTICATED`; valid user → no throw; messages never contain the token
- [ ] T058 [P] [US7] Extend `tests/unit/graphql/graphql.config.spec.ts`: context factory with valid header → `{ req, user, authError: null }`; invalid → `{ user: null, authError }`; missing header → `authError` `INVALID/missing`; verifier is called at most once per request
- [ ] T059 [P] [US7] Extend `tests/unit/controllers/auth/roles.guard.spec.ts` and `jwt-auth.guard.spec.ts` with the GraphQL branch: `JwtAuthGuard` reads `GqlExecutionContext` context `user` (no re-verify); `RolesGuard` denies with `GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } })`; and `tests/unit/controllers/orders.resolver.spec.ts` asserts class-level `@Roles(CUSTOMER, ADMIN)` metadata
- [ ] T060 [P] [US7] Update `tests/integration/list-orders.graphql.integration.spec.ts` and `tests/component/list-orders.component.spec.ts` (plus GraphQL calls in `tests/component/order-projection.component.spec.ts` and others under `tests/component/`) to send a CUSTOMER or ADMIN token; add cases: no token / invalid token on `orders`, `order(orderId)` and `{ __schema { queryType { name } } }` → `errors[0].extensions.code === 'UNAUTHENTICATED'` and no `data`; unknown-roles token → `FORBIDDEN`, field `null`; `TestIdentity.setAvailable(false)` before first use → `SERVICE_UNAVAILABLE`; CUSTOMER and ADMIN tokens → same results as today (unscoped, FR-022); HTTP status 200 in all cases
- [ ] T061 [P] [US7] Confirm `tests/unit/graphql/schema.spec.ts` still passes and `npm run schema:generate` leaves `docs/schema.gql` unchanged (contract: schema unchanged)

### Implementation for User Story 7

- [ ] T062 [P] [US7] Create `src/graphql/graphql-context.ts`: `interface GraphqlContext { req: Request; user: AccessTokenClaims | null; authError: AccessTokenError | null }` and `buildGraphqlContext(verifier)` returning the async context function (`extractBearerToken` → `verifier.verify`, catch `AccessTokenError` into `authError`, rethrow anything else); JSDoc
- [ ] T063 [P] [US7] Create `src/graphql/graphql-auth.plugin.ts`: Apollo `ApolloServerPlugin<GraphqlContext>` with `requestDidStart` → `didResolveOperation` throwing the errors of contracts/graphql-auth.md when `contextValue.user` is null (R11); JSDoc
- [ ] T064 [US7] Update `src/graphql/graphql.config.ts` to take the verifier and return options with `context: buildGraphqlContext(verifier)` and `plugins: [graphqlAuthPlugin]`, keeping existing options (playground, `autoSchemaFile`, formatError)
- [ ] T065 [US7] In `src/app.module.ts` switch `GraphQLModule.forRoot` to `forRootAsync({ driver: ApolloDriver, imports: [AuthModule], inject: [AccessTokenVerifier], useFactory: … })` using T064; no network call in the factory
- [ ] T066 [US7] Add the GraphQL branch to `src/controllers/auth/jwt-auth.guard.ts` (read `GqlExecutionContext.create(ctx).getContext<GraphqlContext>()`; `user` null → throw the `UNAUTHENTICATED` `GraphQLError`; otherwise allow) and to `src/controllers/auth/roles.guard.ts` (same effective-roles rule, failure → `FORBIDDEN` `GraphQLError`)
- [ ] T067 [US7] Ensure `src/controllers/auth/auth-exception.filter.ts` and `src/graphql/graphql-user-input.filter.ts` let `GraphQLError`s with `UNAUTHENTICATED` / `FORBIDDEN` / `SERVICE_UNAVAILABLE` codes pass through unchanged (no remap to `INTERNAL_SERVER_ERROR` or `BAD_USER_INPUT`); add a case to `tests/unit/graphql/graphql-user-input.filter.spec.ts`
- [ ] T068 [US7] Extend `src/controllers/auth/current-user.decorator.ts` with the GraphQL branch (`GraphqlContext.user`) and add the case to `tests/unit/controllers/auth/current-user.decorator.spec.ts` (create it covering HTTP too)
- [X] T069 [US7] Add `@Roles(Role.CUSTOMER, Role.ADMIN)` at class level on `src/controllers/orders.resolver.ts`; no change to query handlers or results (unscoped until US-12) (landed with US6, as the route-policy validator requires it)

**Checkpoint**: Anonymous read-model access closed; all seven stories done.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Docs, governance, the no-token-in-logs guarantee and the final gate.

- [ ] T070 [P] Component test `tests/component/auth-no-token-leak.component.spec.ts` (SC-006): spy on Nest `Logger` methods and capture `process.stdout`/`process.stderr` writes while sending the 401 cases of T027, a 403 (ADMIN on `POST /orders`), a 503 (`setAvailable(false)` on a fresh app) and GraphQL `UNAUTHENTICATED`; assert no captured line and no response body contains any used token or its first 20 characters
- [ ] T071 [P] Write `docs/adr/0008-identity-token-verification.md` (Context / Decision / Consequences, per `docs/adr/template.md`): `jose` 5.10 (why not 6.x, `jsonwebtoken`, passport), lazy JWKS with single-flight, 60 s cooldown and fixed 300 s cache (jose cannot read `Cache-Control`; cooldown also follows the first load), last-good fallback, 401 vs 503, global guards and default deny, effective roles, ownership in the domain answered as 404, GraphQL verified in context + plugin, follow-up: MINOR constitution amendment adding a security principle (R16); add it to `docs/adr/README.md`
- [ ] T072 [P] Update `README.md`: "Authentication" section (get a token from ecommerce-identity login, `Authorization: Bearer <token>`, table of routes and roles from data-model "Access rule", meanings of 401/403/404/503, GraphQL requires a token and is **not scoped to the caller until US-12**), the four env vars in the configuration table, `POST /orders` example without `customerId`
- [ ] T073 [P] Update `CLAUDE.md`: auth rules (global `JwtAuthGuard` → `RolesGuard`, every route `@Public` or `@Roles`, startup fails otherwise, `@CurrentUser` is the only source of user data, effective roles, ownership via `Order.isAccessibleBy` → 404, GraphQL context + plugin, never log tokens, no JWKS fetch at startup) and the four env vars; update `src/README.md` with the new `src/infra/auth/`, `src/controllers/auth/` and `src/graphql/` files
- [ ] T074 [P] Apply plan "Open points" 1 to `specs/009-identity-token-auth/spec.md` FR-009: replace "honour Identity's max-age, fallback 10 minutes" and "the first load does not count" with the implemented behaviour (fixed 300 s max age; cooldown counted from any fetch, including the first), and align the matching Assumption ("Key cache freshness")
- [ ] T075 Keep `docs/events/` untouched (no event contract change) and run `npm run schema:generate`; confirm `git diff docs/schema.gql` is empty
- [ ] T076 Run the quality gate in order: `npm run build`, `npm run lint` (`--max-warnings 0`), `npm run format:check`, `npm run test` (component tests need Docker); fix every failure
- [ ] T077 Walk through the manual steps of `specs/009-identity-token-auth/quickstart.md` against the local stack (ecommerce-infra + ecommerce-identity) and note the result

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none. T005 depends on T001 (`jose`).
- **Foundational (Phase 2)**: after Setup. Blocks every story.
- **US1 (Phase 3)**: after Foundational. Blocks US2–US7 (they need the verifier, guards,
  `AuthModule` and token-sending test suites).
- **US2, US3, US4 (Phases 4–6)**: after US1. Independent of each other in logic, but all three
  edit `src/controllers/orders.controller.ts`, so do them one after another (or merge carefully).
- **US5 (Phase 7)**: after US1 (touches only the verifier and adds tests). Can run in parallel
  with US2–US4.
- **US6 (Phase 8)**: after US2–US4 (the validator requires every route to carry `@Roles`; the
  Swagger test asserts their roles) and before US7 is merged, or US7's T069 must land in the same
  change (the resolver needs `@Roles` for the validator to pass).
- **US7 (Phase 9)**: after US1; T069 must land no later than US6's T053.
- **Polish (Phase 10)**: after all stories.

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬─ US2 → US3 → US4 ─┐
                            ├─ US5 ─────────────┼─ US6 ─┐
                            └─ US7 ─────────────┘       └─ Polish
```

### Within Each User Story

- Write the tests first and see them fail, then implement.
- Types and domain before services, services before controllers, controllers before wiring.
- Commit after each story checkpoint, with the quality gate green.

### Parallel Opportunities

- Setup: T002, T003, T004 together.
- Foundational: T006–T011 together (separate files); then T012 with T013/T014.
- US1: T015–T018 together; T025 and T026 split across files.
- US2: T028–T030 together. US3: T034–T037 together. US4: T042 alongside other stories' tests.
- US5 entirely in parallel with US2–US4.
- US6: T050, T051 together; T052 and T054 together.
- US7: T057–T063 together.
- Polish: T070–T074 together.

---

## Parallel Example: User Story 1

```text
# Tests first, together:
Task: "T015 Verifier unit tests in tests/unit/infra/auth/access-token.verifier.spec.ts"
Task: "T016 JwtAuthGuard unit tests in tests/unit/controllers/auth/jwt-auth.guard.spec.ts"
Task: "T017 AuthExceptionFilter unit tests in tests/unit/controllers/auth/auth-exception.filter.spec.ts"
Task: "T018 AuthModule config tests in tests/unit/infra/auth/auth.module.spec.ts"

# Then, after T022/T023, existing suites in parallel:
Task: "T025 Send tokens in REST integration specs"
Task: "T026 Send tokens in REST component specs"
```

## Parallel Example: User Story 7

```text
Task: "T062 GraphqlContext in src/graphql/graphql-context.ts"
Task: "T063 Auth plugin in src/graphql/graphql-auth.plugin.ts"
Task: "T057 Plugin unit tests in tests/unit/graphql/graphql-auth.plugin.spec.ts"
Task: "T058 Context factory tests in tests/unit/graphql/graphql.config.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup, Phase 2 Foundational.
2. Phase 3 US1: every REST route requires a valid Identity token.
3. **Stop and validate**: T027 passes, all existing suites green with tokens.

### Incremental Delivery

1. US1 → anonymous REST access closed (MVP).
2. US2 → US3 → US4 → REST ownership and roles complete (all P1).
3. US5 → resilient to Identity outages and rotation.
4. US6 (+ US7's T069) → default deny and Swagger docs.
5. US7 → GraphQL closed to anonymous callers.
6. Polish → ADR 0008, README, CLAUDE.md, leak test, quickstart.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- Never put the ownership rule in the controller or a guard: it lives in `Order.isAccessibleBy`
  and is enforced by `CancelOrderService` (FR-019).
- Never add an awaited JWKS fetch to a factory or lifecycle hook.
- Never log or echo a token, even truncated.
