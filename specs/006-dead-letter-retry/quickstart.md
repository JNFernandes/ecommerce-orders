# Quickstart: validate Dead-Letter Retry (US-08)

The states and schedule are in [contracts/dead-letter-retry-behaviour.md](contracts/dead-letter-retry-behaviour.md).

## Automated

```bash
npm run build && npm run lint && npm run format:check
npm run test:unit          # retry policy (fake time), worker (fake timers), consumer process()
npm run test:integration   # processNextDue claiming on PostgreSQL: SKIP LOCKED, rollback, backfill
npm run test:component     # Kafka + Postgres: publish fails then succeeds; inbound retry; exhaustion
```

## Live (ecommerce-infra up; Payments running)

```bash
npm run migration:run     # adds the bookkeeping; existing MALFORMED rows → EXHAUSTED
psql: select status, count(*) from consumed_message_dead_letters group by status;
DEAD_LETTER_RETRY_INTERVAL_MS=5000 PORT=3001 node dist/main
```

**Existing rows**: the `RETRIES_EXHAUSTED` row (the US-05 `OrderPlaced` for order `8fcc9f9f…`)
becomes `RESOLVED` on the first cycle. It was already applied to the view, so the retry is a
duplicate and counts as success. The `MALFORMED` rows stay `EXHAUSTED`.

**Broker outage**:

1. `docker stop ecommerce-kafka-1`
2. `POST /orders` → `201` (saved). A row appears in `order_dead_letters` with `status = PENDING_RETRY`.
   While Kafka is down, its `retryCount` grows and `nextRetryAt` moves further out.
3. `docker start ecommerce-kafka-1`. Within one or two intervals after the next due time, the row
   becomes `RESOLVED` (with `resolvedAt`), `OrderPlaced` reaches Kafka with the same `eventId`,
   Payments answers, and the order becomes `CONFIRMED` in Postgres and in the read model.

**Exhaustion**: insert an inbound row whose `rawValue` is a valid `payments.payment-processed`
message for a random `orderId`, and use `DEAD_LETTER_MAX_RETRIES=3` with small delays. The row is
retried 3 times with growing gaps, then becomes `EXHAUSTED`, and an error log names it.

**Two instances**: run a second instance on another port with the same settings. Each due row is
resolved once (`retryCount` never jumps by 2 in one cycle), and both logs together show each row
id once per attempt.
