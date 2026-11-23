# Data Model: Identity Token Auth (US-11)

No database change and no migration: orders already store `customerId` (the owner). Everything
below lives in memory.

## Role (enum, `src/infra/auth/role.enum.ts`)

`CUSTOMER`, `ADMIN`. Unknown role strings in a token are dropped when claims are built.

## AccessTokenClaims (`src/infra/auth/access-token-claims.ts`)

| Field | Type | Rule |
|---|---|---|
| `sub` | `string` | non-empty; Identity user id |
| `customerId` | `string \| undefined` | UUID when present; only from the token |
| `roles` | `readonly Role[]` | known roles only; may be empty (then 403 everywhere) |

Frozen, built only by `AccessTokenVerifier` after signature, `iss`, `aud`, `exp`/`nbf`/`iat` checks.
Exposed to handlers by `@CurrentUser()` (REST and GraphQL). Never stored or logged.

## AccessTokenError (`src/infra/auth/access-token.error.ts`)

| Field | Values | Use |
|---|---|---|
| `kind` | `INVALID` \| `KEYS_UNAVAILABLE` | REST 401 / 503; GraphQL `UNAUTHENTICATED` / `SERVICE_UNAVAILABLE` |
| `category` | `missing`, `malformed`, `algorithm`, `signature`, `unknown-kid`, `issuer`, `audience`, `expired`, `claims`, `fetch` | log line only |

Message is fixed and never contains the token.

## Key set state (inside `AccessTokenVerifier`)

- jose remote set: `cooldownDuration` 60 s, `cacheMaxAge` 300 s, one shared pending fetch.
- `lastGood: { jwks, uat }` (jose `jwksCache`): fallback after a failed refresh; none → `KEYS_UNAVAILABLE`.

## AuthConfig (`src/config/configuration.ts`, key `auth`)

| Env | Field | Default |
|---|---|---|
| `IDENTITY_JWKS_URL` | `jwksUrl` | `http://localhost:3001/.well-known/jwks.json` |
| `JWT_ISSUER` | `issuer` | none, required at startup |
| `JWT_AUDIENCE` | `audience` | none, required at startup |
| `JWT_CLOCK_TOLERANCE_SECONDS` | `clockToleranceSeconds` | `5` |

## Access rule (route metadata)

- `@Public()` → `IS_PUBLIC_KEY = true`
- `@Roles(...roles)` → `ROLES_KEY = Role[]` (non-empty)
- Neither on handler or class → startup error naming `Class.method`.

| Route | Rule |
|---|---|
| `POST /orders` | `@Roles(CUSTOMER)` |
| `POST /orders/:orderId/cancel` | `@Roles(CUSTOMER, ADMIN)` + ownership |
| `POST /orders/:orderId/confirm` | `@Roles(ADMIN)` |
| GraphQL `orders`, `order` | `@Roles(CUSTOMER, ADMIN)` (class level) |
| `/api`, `/api-json` (Swagger) | public (not Nest routes) |

Effective roles: `CUSTOMER` counts only when `customerId` is present.

## OrderRequester (domain, `src/domain/order-requester.ts`)

`{ customerId: string | null; isAdmin: boolean }`, built by the controller from the claims. No JWT
types in the domain.

`Order.isAccessibleBy(requester): boolean` = `requester.isAdmin || requester.customerId ===
this.customerId`. Pure, unit tested.

## Command changes

| Command | Before | After |
|---|---|---|
| `PlaceOrderCommand` | `(customerId, items)`, id from body | same shape, id from `claims.customerId` |
| `CancelOrderCommand` | `(orderId)` | `(orderId, requester: OrderRequester)` |
| `ConfirmOrderCommand` | `(orderId)` | unchanged (ADMIN-only at the route) |

`PlaceOrderDto`: `customerId` removed; `forbidNonWhitelisted` turns it into a 400.

## GraphqlContext (`src/graphql/graphql-context.ts`)

`{ req: Request; user: AccessTokenClaims | null; authError: AccessTokenError | null }`.
