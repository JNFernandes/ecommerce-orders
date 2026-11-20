# Implementation Plan: Create Customers from Identity Registrations (US-10)

**Branch**: `feature/US-10-customers-from-identity` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

## Summary

Consume `identity.user-registered` with a new `IdentityEventsConsumer` (copy of the inventory
consumer's shape), dispatch `CreateCustomerCommand`, and insert the customer idempotently (keyed by
`customerId`) in the same transaction as the `processed_events` row. One migration adds
`customers.name/email` and lets `processed_events` hold customer events. Decisions: [research.md](research.md).

## Technical Context

- **Stack**: NestJS 10, TypeScript strict, `@nestjs/cqrs`, TypeORM/PostgreSQL, kafkajs
- **Tests**: Jest; integration with testcontainers Postgres; component with real Kafka + Postgres
- **Constraints**: no awaited Kafka connect at startup; offsets committed only after the DB save
- **Scale**: one row per registration; no performance concerns
- No open NEEDS CLARIFICATION.

## Constitution Check

| Principle | Status |
|---|---|
| I DDD / layering | ✅ `Customer.register` in domain; consumer parses + dispatches only; repository persists |
| II CQRS | ✅ write side only; read model untouched |
| III Write flow | ✅ domain → repository (one transaction); nothing published |
| IV Type safety | ✅ class-validator DTO for the message; no `any` |
| V/VI Tests | ✅ unit, integration, component (below) |
| VII Kafka | ✅ `customerId` not `aggregateId`; dedupe in same tx; backoff; dead-letter; own group |
| VIII Branching | ✅ `feature/US-10-customers-from-identity` |
| IX Quality gate | ✅ build, lint, format, test before each commit |

Post-design re-check: no violations; Complexity Tracking empty.

## Project Structure

```text
src/domain/customer.ts                                   new: Customer.register + validation error
src/commands/create-customer.command.ts                  new
src/commands/inbound-event-ref.ts                        orderId optional, + customerId
src/services/create-customer.service.ts                  new @CommandHandler
src/repositories/customer.repository.ts                  + createIfAbsent(customer, ref) → { created }
src/repositories/processed-event.repository.ts           write customerId
src/infra/database/entities/customer.entity.ts           + name, email; JSDoc no longer "read-only"
src/infra/database/entities/processed-event.entity.ts    orderId nullable, + customerId, enum values, CHECKs
src/infra/database/migrations/20261119120000-AddCustomerRegistration.ts   new
src/dto/user-registered-message.dto.ts                   new
src/infra/kafka/user-registered-message.parser.ts        new
src/infra/kafka/identity-events.consumer.ts              new
src/infra/dead-letter/dead-letter-retry.worker.ts        + identity consumer in inboundHandlers
src/config/configuration.ts, .env.example                + KAFKA_IDENTITY_GROUP_ID
src/app.module.ts                                        register consumer + handler
docs/events/user-registered.md, docs/adr/0007-*.md, docs/adr/README.md, README.md, CLAUDE.md
```

## Tests

- **Unit**: parser (valid; aggregateId ignored; bad JSON, non-object, missing eventId/customerId/email,
  non-UUID, empty email, version≠1, bad name type); `Customer.register`; handler (new → created,
  existing → no-op outcome, invalid → error); config default.
- **Integration** (Postgres): `createIfAbsent` creates; existing id unchanged; concurrent same id → one row,
  both succeed; duplicate eventId → `EventAlreadyProcessedError`; migration up/down keeps existing rows.
- **Component** (Kafka + Postgres): event creates customer (id = customerId, not aggregateId); redelivery
  does not duplicate; invalid message → `consumed_message_dead_letters`, next message processed;
  `POST /orders` for the new customer → `201`.

## Docs

README: consumer implemented, `KAFKA_IDENTITY_GROUP_ID`, eventual consistency (early order → `404`,
retry), seed marked legacy. `docs/events/user-registered.md` consistent with ecommerce-infra.
CLAUDE.md: "consumer not built yet" → implemented. ADR 0007.

## Complexity Tracking

None.
