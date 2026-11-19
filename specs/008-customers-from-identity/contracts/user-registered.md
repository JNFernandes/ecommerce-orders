# Consumed: `identity.user-registered`

Source of truth: `ecommerce-infra/docs/events.md`. Consumer group `KAFKA_IDENTITY_GROUP_ID`.

| Field | Type | Orders validation |
|---|---|---|
| `eventId` | UUID | required → else dead-letter (not retryable) |
| `aggregateId` | UUID (user id) | ignored; never stored or used as customer id |
| `occurredAt` | ISO string | not used |
| `version` | int | must be `1` → else dead-letter |
| `customerId` | UUID | required → customer id |
| `email` | string | required, non-empty |
| `name` | string | optional, ≤100 chars; wrong type → dead-letter |

Bad JSON / non-object → dead-letter (not retryable). Unknown extra fields ignored.

| Outcome | processed_events.outcome | Offset |
|---|---|---|
| customer created | `CUSTOMER_CREATED` | committed after save |
| customer already exists | `IGNORED_CUSTOMER_EXISTS` | committed after save |
| `eventId` already processed | (none) | committed |
| save fails | — | retried with backoff, then retryable dead letter, then committed |

Orders publishes nothing in response.
