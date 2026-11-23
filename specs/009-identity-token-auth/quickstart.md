# Quickstart: validate US-11

## Automated

```bash
npm run build && npm run lint && npm run format:check && npm run test   # component tests need Docker
```

Tests mint tokens with `tests/support/test-identity.ts` (local RSA key + JWKS server); no Identity
needed.

## Manual (local stack)

Prerequisites: `ecommerce-infra` up (`docker compose up -d`), `ecommerce-identity` running on
`:3001`, Orders `.env` with `IDENTITY_JWKS_URL=http://localhost:3001/.well-known/jwks.json`,
`JWT_ISSUER=http://localhost:3001`, `JWT_AUDIENCE=ecommerce`.

1. **Startup without Identity**: stop Identity, `npm run start`. Orders starts; `GET /api`
   answers `200`; `POST /orders` with any token → `503`.
2. **Get tokens**: start Identity; register a customer and log in (see Identity README) →
   `$CUSTOMER_TOKEN`; log in as the seeded admin → `$ADMIN_TOKEN`. Wait for the
   `identity.user-registered` event to create the customer in Orders.
3. **401**: `POST /orders` with no header, `Bearer garbage`, and an edited token → identical `401`
   with `WWW-Authenticate: Bearer`.
4. **Place**: `POST /orders` with `$CUSTOMER_TOKEN` and `{"items":[...]}` → `201`; the order row
   and the `orders.order-placed` event carry the token's `customerId`. Adding `"customerId"` → `400`.
   With `$ADMIN_TOKEN` → `403`.
5. **Cancel**: second customer's token on the first customer's order → `404` (same body as a random
   UUID); owner → `200 CANCELLED`; admin on another pending order → `200`.
6. **Confirm**: `$CUSTOMER_TOKEN` → `403`; `$ADMIN_TOKEN` → `200 CONFIRMED`.
7. **GraphQL**: `{ orders { totalCount } }` without token → `UNAUTHENTICATED`, no data; with either
   token → result as before.
8. **Logs**: grep the Orders log for the first 20 characters of each token → no match.
9. **Swagger**: `/api` shows the Authorize button; each operation lists its roles and 401/403/503.
