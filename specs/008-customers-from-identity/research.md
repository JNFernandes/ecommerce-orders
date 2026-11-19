# Research: US-10 Customers from Identity

Each entry: **Decision** — reason. *(Alternative rejected.)*

1. **Columns**: add nullable `name varchar(100)` and `email varchar(320)` to `customers` — the table
   holds only `id`, `createdAt`; nullable keeps seeded rows valid. *(NOT NULL + backfill: no source
   data.)*
2. **Dedupe store**: reuse `processed_events`; make `orderId` nullable, add `customerId uuid`, widen
   the CHECK to `num_nonnulls(paymentId, reservationId, customerId) = 1` plus
   `(customerId IS NULL) = (orderId IS NOT NULL)` — one idempotency mechanism, as the user asked.
   *(Separate `processed_identity_events` table: duplicates the mechanism.)*
3. **Outcome values**: add `CUSTOMER_CREATED`, `IGNORED_CUSTOMER_EXISTS` to
   `processed_event_outcome_enum` — records what happened, like the order outcomes.
4. **Never store `aggregateId`**: the ref carries `customerId` only — spec edge case says the user
   id is never stored. *(A `userId` column for audit: contradicts the spec.)*
5. **Idempotent insert**: one transaction: `INSERT … ON CONFLICT (id) DO NOTHING` on `customers`, then
   insert the `processed_events` row; `created = rowCount === 1` — handles concurrent duplicates
   without errors (US2 scenario 3). *(Read-then-insert: races.)*
6. **Duplicate `eventId`**: the `processed_events` unique violation → `EventAlreadyProcessedError`,
   treated as success, as the existing consumers do.
7. **Domain**: `Customer.register({ id, name, email })` in `src/domain/customer.ts` validates
   (UUID id, non-empty email, name ≤100 or null) and is what the repository persists. The rule
   "an existing customer is left unchanged" is enforced atomically by the insert (item 5); the
   handler maps `created` to the processed-event outcome.
8. **Command**: `CreateCustomerCommand` → `CreateCustomerService` (`@CommandHandler`): build
   `Customer`, call `CustomerRepository.createIfAbsent(customer, ref)`, log. No Kafka publish (FR-006).
9. **Parser**: `user-registered-message.parser.ts` + `UserRegisteredMessageDto` (class-validator),
   same shape as `stock-message.parser.ts`; required `eventId`, `customerId` (UUIDs), `email`
   (non-empty), `version === 1`; `name` optional string ≤100 (wrong type → malformed). Throws
   `MalformedMessageError`.
10. **Consumer**: `IdentityEventsConsumer` copied from `InventoryEventsConsumer` (KafkaConnectLoop,
    `consumeWithDeadLetter`, `topics`, `process()`), registered in `DeadLetterRetryWorker`'s inbound
    handlers — reuses all retry/dead-letter code.
11. **Config**: `KAFKA_IDENTITY_GROUP_ID` (default `ecommerce-orders-identity-consumer`) — groups
    with different subscriptions must not be shared. Topic constant `identity.user-registered`.
12. **Dead-letter rows**: `consumed_message_dead_letters.orderId` stays null for identity
    messages; `describe()` returns `{ eventId }` — no schema change needed there.
13. **ADR**: `docs/adr/0007-customers-from-identity-events.md` (constitution migration note).
