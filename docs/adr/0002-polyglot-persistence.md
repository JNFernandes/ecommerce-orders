# 0002. Polyglot persistence: PostgreSQL for invariants, MongoDB for read shapes

- **Status**: Accepted
- **Date**: 2026-11-11

## Context

The platform's services store two different kinds of data:

- **State with invariants**: order status transitions, payments and stock levels. These need
  transactions, constraints and a well-defined schema.
- **Data shaped for reading or appending**: denormalised order views served over GraphQL and the
  log of notifications sent. These are written once (or replaced wholesale) and read by
  document, and a rigid relational schema gets in the way.

The shared local infrastructure (`ecommerce-infra`) already provides both PostgreSQL and MongoDB.

## Decision

We will choose the store per use case rather than standardise on one:

| Data | Store |
|---|---|
| Orders write side | PostgreSQL (TypeORM) |
| Payments | PostgreSQL |
| Inventory | PostgreSQL |
| Orders read model | MongoDB (`@nestjs/mongoose`) |
| Notifications log | MongoDB |

Rule of thumb: **PostgreSQL where invariants matter, MongoDB where the read shape matters.**

## Consequences

- Each store is used where it is strongest: transactional integrity on the write sides, and
  flexible document shapes for read models and logs.
- There are two database technologies to run, back up, monitor and test. Component tests need
  real containers for both (testcontainers for PostgreSQL and MongoDB).
- Data in MongoDB is derived from events and can be rebuilt by replaying them, so it is never
  the source of truth for an invariant.
- Code must not mix the two models: TypeORM entities stay on the write side and Mongoose schemas
  stay on the read side.
