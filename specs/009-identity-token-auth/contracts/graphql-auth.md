# Contract: GraphQL access (US-11)

`POST /graphql` with `Authorization: Bearer <token>`. Schema unchanged (`docs/schema.gql` does not
change). Results are **not** scoped to the caller until US-12.

| Case | `data` | `errors[0].extensions.code` | Message |
|---|---|---|---|
| no / invalid token, any operation (introspection included) | absent | `UNAUTHENTICATED` | `Unauthorized` |
| keys unavailable, none loaded | absent | `SERVICE_UNAVAILABLE` | `Authentication is temporarily unavailable, please retry` |
| valid token, no `CUSTOMER`/`ADMIN` | `null` for the field | `FORBIDDEN` | `Forbidden` |
| valid `CUSTOMER` or `ADMIN` | as today | none | |

HTTP status stays `200` for these (existing GraphQL error convention). No message reveals why a
token was rejected. Resolvers can read the claims from the context (`GraphqlContext.user`) or with
`@CurrentUser()`.
