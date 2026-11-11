# 0001. CQRS read model lives inside the Orders service

- **Status**: Accepted
- **Date**: 2026-11-11

## Context

The Orders service applies CQRS: commands arrive over REST and change the `Order` aggregate,
which is persisted in PostgreSQL. Clients also need to query orders through GraphQL, in shapes
that suit reading (denormalised and filterable) rather than the normalised write schema.

Earlier notes (`specs/001-place-order/research.md`, the old `src/README.md`) proposed putting the
read side in a separate future service. In practice this read side has no consumers other than
Orders' own clients, and a separate service would add a deployable, a repo and a contract to
maintain for no clear gain.

## Decision

We will keep both sides of CQRS inside the Orders service, as separate paths:

- **Write side**: REST → command bus → Domain → PostgreSQL (TypeORM) → Kafka `orders.*` event,
  in that order.
- **Read side**: GraphQL → query bus → query handlers → a **MongoDB** read model.
- The read model is updated only by a **projection** that consumes the service's own
  `orders.*` events from Kafka. Query handlers never read PostgreSQL, and read-side models
  never reuse write-side TypeORM entities.

## Consequences

- One deployable owns everything about orders, and the read and write sides can still scale and
  evolve their storage independently.
- The read model is **eventually consistent**: a GraphQL query issued right after a REST command
  may not see the change yet. We accept this; clients that need the result immediately use the
  REST response.
- The projection must be idempotent (dedupe by `eventId`) and commit offsets only after the
  MongoDB write, so that it can be replayed safely or rebuilt from the topics.
- The service now depends on MongoDB as well as PostgreSQL and Kafka (see ADR 0002).
