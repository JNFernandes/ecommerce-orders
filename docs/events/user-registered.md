# Event: `UserRegistered` (consumed)

**Topic**: `identity.user-registered`

**Producer**: `ecommerce-identity`. Platform contract: `ecommerce-infra/docs/events.md`
(Identity events). This page must stay consistent with it.

**Consumer in this service**: `IdentityEventsConsumer` (`src/infra/kafka/identity-events.consumer.ts`),
consumer group `KAFKA_IDENTITY_GROUP_ID` (default `ecommerce-orders-identity-consumer`).
Introduced by US-10.

**Meaning**: a user registered in Identity. Orders creates the matching customer so that orders
can be placed for it ([ADR 0007](../adr/0007-customers-from-identity-events.md)). Orders publishes
nothing in response.

## Payload

```json
{
  "eventId": "9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11",
  "aggregateId": "5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33",
  "occurredAt": "2026-11-19T10:00:00.000Z",
  "version": 1,
  "customerId": "4889fbea-c49f-4094-8ca9-45d79508477e",
  "email": "ada@example.com",
  "name": "Ada Lovelace"
}
```

| Field | Type | Required here | Use in Orders |
|---|---|---|---|
| `eventId` | UUID | yes | Dedupe key, stored in `processed_events`. |
| `aggregateId` | UUID | yes | **The user id.** Validated, never stored, **never used as a customer id**. |
| `occurredAt` | ISO 8601 | yes | Validated, otherwise not used. |
| `version` | integer | yes, must be `1` | Any other value means the message is malformed. |
| `customerId` | UUID | yes | **The customer to create**: becomes `customers.id`. |
| `email` | string | yes, non-empty | Stored as `customers.email`. |
| `name` | string | no, ≤ 100 chars | Stored as `customers.name` (null when absent). A non-string is malformed. |

Unknown extra fields are ignored.

## Processing

| Outcome | `processed_events.outcome` | Offset |
|---|---|---|
| Customer created | `CUSTOMER_CREATED` | committed after the save |
| Customer already exists (left unchanged) | `IGNORED_CUSTOMER_EXISTS` | committed after the save |
| `eventId` already processed | (none) | committed |
| Malformed (bad JSON, non-object, failed rule above) | — | dead-lettered `MALFORMED` (not retried), committed |
| Save keeps failing | — | retried with backoff, dead-lettered `RETRIES_EXHAUSTED`, committed |

Eventual consistency: an order for a customer Orders has not created yet gets `404`; the client
retries later.
