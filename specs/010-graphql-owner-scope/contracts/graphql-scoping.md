# Contract: GraphQL owner scoping (US-12)

Schema shape unchanged (`docs/schema.gql`; descriptions only). Behaviour per caller, after US-11
authentication (`UNAUTHENTICATED` / `SERVICE_UNAVAILABLE` unchanged) and argument validation
(`BAD_USER_INPUT` unchanged):

| Caller (effective roles) | `orders(...)` | `order(orderId)` |
|---|---|---|
| `ADMIN` (any `customerId`) | all orders; `customerId` filters normally | any order, `null` if unknown |
| `CUSTOMER` with `customerId = A` | only A's orders; `totalCount`/`hasNextPage` over A's orders | A's order, else `null` |
| `CUSTOMER` A, `customerId: A` | same as no `customerId` | — |
| `CUSTOMER` A, `customerId: B` | `items: []`, `totalCount: 0`, `hasNextPage: false`, no `errors` | — |
| no `ADMIN`, no `customerId` | `FORBIDDEN`, `data: null` | `FORBIDDEN`, `data: {"order": null}` (nullable field) |
| no token | `UNAUTHENTICATED` (HTTP 200, no data); REST would be 401 | same |

Another customer's order and an unknown id produce byte-identical responses
(`{"data":{"order":null}}`). `status`, ordering, `limit`/`offset` apply inside the scope. Tokens
never appear in logs or errors.
