# 0007. Customers are created from Identity's user-registered events

- **Status**: Accepted
- **Date**: 2026-11-20

## Context

Orders checks that an order's `customerId` exists in its own `customers` table. Until US-10 that
table was filled only by `npm run seed:customers`. Constitution 1.3.0 makes
`identity.user-registered` (published by ecommerce-identity) the only source of customers. The
event's `aggregateId` is the user id, not the customer id, and must not be stored. Kafka delivers
at least once, and two registrations for the same customer may be processed concurrently.

## Decision

We will consume `identity.user-registered` with `IdentityEventsConsumer` (own group
`KAFKA_IDENTITY_GROUP_ID`) and dispatch `CreateCustomerCommand`, keyed by the payload's
`customerId`; the `aggregateId` is never stored.

We will reuse `processed_events` for dedupe instead of adding a table: `orderId` becomes nullable,
a nullable `customerId` is added, the CHECK requires exactly one of `paymentId`, `reservationId`,
`customerId` and an `orderId` exactly when there is no `customerId`, and the outcome enum gains
`CUSTOMER_CREATED` and `IGNORED_CUSTOMER_EXISTS`.

We will create the customer with `INSERT … ON CONFLICT ("id") DO NOTHING` and insert the
`processed_events` row in the same transaction. An existing customer is left unchanged.

## Consequences

- One idempotency mechanism for every consumer; the consumer reuses `consumeWithDeadLetter`,
  backoff and dead-letter retry unchanged.
- Concurrent duplicates resolve without errors: one insert wins, the other records
  `IGNORED_CUSTOMER_EXISTS`.
- Later profile changes in Identity are not reflected (no update event is consumed yet).
- Creation is eventually consistent: an early order gets `404` and the client retries.
- `npm run seed:customers` remains for local development and tests only.
