# 0004. Read-model projection: order-independent, idempotent and deterministic

- **Status**: Accepted
- **Date**: 2026-11-11

## Context

ADR 0001 puts the order read model in MongoDB, fed by a projection of the service's own events.
Those events come from three **independent** topics (`orders.order-placed`,
`orders.order-confirmed`, `orders.order-cancelled`). Kafka orders messages only within a
partition, so a confirmation can be projected before its `OrderPlaced`.

Messages are also redelivered (restarts, rebalances), and the read model must be rebuildable by
replaying the topics. Several instances may project concurrently. Finally, a MongoDB outage
should not turn healthy events into dead letters.

## Decision

We will project events with these rules (details in `docs/read-model.md`):

1. **Order-independent merge.** A pure function applies one event to the current view. A late
   `OrderPlaced` fills in data without touching a terminal status. Conflicting terminal events
   resolve to the one that occurred first (`occurredAt`, then `eventId`).
2. **Per-document dedupe.** Each view stores the ids of the events applied to it, and a known id
   is a no-op. There is no separate processed-events store for the read side.
3. **Deterministic documents.** `updatedAt` is the latest event time (never wall-clock),
   `appliedEventIds` is kept sorted, and `revision` counts applied events. Replaying, in any
   order, reproduces identical documents.
4. **Optimistic concurrency.** The whole document is written conditionally on `revision`, so
   applying an event and recording its id is one atomic write. A conflict is retried.
5. **Outage vs poison.** Malformed events and persistent failures are dead-lettered (shared
   `consumed_message_dead_letters`). A MongoDB connectivity failure is rethrown without
   committing, so the event is redelivered when MongoDB is back.

## Consequences

- Rebuilds are safe and simple: reset the consumer group to earliest, optionally after dropping
  the collection.
- The view carries internal bookkeeping (`appliedEventIds`, `statusEventId`, `revision`) that
  readers must not expose.
- Backfill and rebuild are bounded by Kafka retention (7 days today). Older orders would need a
  rebuild from PostgreSQL, or longer or compacted retention.
- While MongoDB is down, the projection stalls without losing data (its lag grows) instead of
  producing dead letters. Monitoring consumer lag becomes the signal to watch.
- `updatedAt` reports when the order last changed, not when the view was last written.
