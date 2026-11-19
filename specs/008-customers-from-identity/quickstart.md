# Quickstart: US-10

Prereqs: `ecommerce-infra` up (`docker compose up -d`), `npm run migration:run`, `npm run start:dev`.

1. **Create**: publish to `identity.user-registered`
   `{"eventId":"<uuid1>","aggregateId":"<userId>","occurredAt":"2026-11-19T10:00:00Z","version":1,"customerId":"<custId>","email":"a@b.c","name":"Ana"}`
   → `SELECT * FROM customers WHERE id='<custId>'` returns name/email; no row with id `<userId>`.
2. **Order**: `POST /orders` with `customerId=<custId>` → `201`. With an unregistered id → `404`.
3. **Redelivery**: republish step 1 → still one customer; publish with `<uuid2>` and another name →
   customer unchanged, `processed_events` outcome `IGNORED_CUSTOMER_EXISTS`.
4. **Invalid**: publish `not json` and a message without `email` → rows in
   `consumed_message_dead_letters` (not retryable); a following valid message is processed.
5. **No Kafka**: stop Kafka, restart the app → HTTP/GraphQL answer.

Automated: `npm run test:unit`, `npm run test:integration`, `npm run test:component`
(`tests/component/customer-registration.component.spec.ts`).
