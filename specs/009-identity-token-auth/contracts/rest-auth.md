# Contract: REST access (US-11)

All protected routes need `Authorization: Bearer <Identity access token>`. Swagger declares
`bearer` (JWT) via `addBearerAuth()`; every protected operation has `@ApiBearerAuth()`, states its
roles in the description and documents `401`, `403`, `503`.

## Common answers

| Status | When | Headers | Body (exact) |
|---|---|---|---|
| `401` | no/non-Bearer header, any invalid token | `WWW-Authenticate: Bearer` | `{"statusCode":401,"message":"Unauthorized"}` |
| `503` | no keys loaded and key set cannot be fetched | none extra | `{"statusCode":503,"message":"Service Unavailable"}` |
| `403` | valid token, no allowed (effective) role | none extra | `{"statusCode":403,"message":"Forbidden","error":"Forbidden"}` (Nest default) |

Order of checks: 401/503 → 403 → 400 (DTO / `ParseUUIDPipe`) → 404/409.

## `POST /orders`: `CUSTOMER` (with `customerId`)

Request body: only `items` (unchanged item schema). Any extra property, `customerId` included → `400`.

| Case | Answer |
|---|---|
| CUSTOMER token, customer exists | `201 { orderId }`, order and `OrderPlaced` carry `claims.customerId` |
| CUSTOMER token, customer not created yet | `404 Customer not found` (unchanged) |
| ADMIN-only token / CUSTOMER without `customerId` | `403` |

## `POST /orders/{orderId}/cancel`: `CUSTOMER` (own orders) or `ADMIN` (any)

| Case | Answer |
|---|---|
| owner, `PENDING` | `200 { orderId, status: CANCELLED }` |
| ADMIN (with or without `CUSTOMER`), `PENDING` | `200` |
| CUSTOMER, order of another customer | `404 {"statusCode":404,"message":"Order not found","error":"Not Found"}`, identical to an unknown id; nothing changed or published |
| owner/ADMIN, not `PENDING` | `409` (unchanged) |
| CUSTOMER-only without `customerId` / no allowed role | `403` |

## `POST /orders/{orderId}/confirm`: `ADMIN`

`200` / `404` / `409` unchanged for ADMIN; `403` for anyone else, order unchanged.

## Public

`GET /api`, `GET /api-json` (Swagger). No health endpoint exists; a future one uses `@Public()`.
