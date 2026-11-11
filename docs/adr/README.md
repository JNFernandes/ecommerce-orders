# Architecture Decision Records

Architectural decisions for `ecommerce-orders` are recorded here, as the project constitution
requires (Documentation Standards).

## Conventions

- One decision per file, named `NNNN-short-title.md` with a four-digit sequential number
  (`0001-...`, `0002-...`).
- Numbers are never reused or renumbered. To reverse a decision, write a new ADR and set the old
  one's status to `Superseded by NNNN`.
- Start from [`template.md`](template.md) (Context / Decision / Consequences).
- Add every new ADR to the index below in the same PR.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-cqrs-read-model-in-orders-service.md) | CQRS read model lives inside the Orders service | Accepted |
| [0002](0002-polyglot-persistence.md) | Polyglot persistence: PostgreSQL for invariants, MongoDB for read shapes | Accepted |
| [0003](0003-saga-by-choreography.md) | Order/payment saga by choreography | Accepted |
| [0004](0004-read-model-projection-consistency.md) | Read-model projection: order-independent, idempotent and deterministic | Accepted |
