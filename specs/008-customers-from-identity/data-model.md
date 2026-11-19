# Data Model: US-10

## Customer (domain `src/domain/customer.ts`, table `customers`)

| Field | Type | Rule |
|---|---|---|
| `id` | uuid PK | = event `customerId`, never `aggregateId` |
| `name` | varchar(100) NULL | new; stored as received, null if absent / pre-US-10 row |
| `email` | varchar(320) NULL | new; non-empty when created from an event, null for pre-US-10 rows |
| `createdAt` | timestamptz | existing, default now() |

Created once; never updated or deleted. Existing id → unchanged (no-op).

## processed_events (existing, extended)

| Change | Detail |
|---|---|
| `orderId` | NOT NULL → NULL |
| `customerId` | new `uuid NULL` |
| CHECK `CHK_processed_events_one_source_id` | `num_nonnulls("paymentId","reservationId","customerId") = 1` |
| CHECK `CHK_processed_events_order_or_customer` | `("customerId" IS NULL) = ("orderId" IS NOT NULL)` |
| `processed_event_outcome_enum` | + `CUSTOMER_CREATED`, `IGNORED_CUSTOMER_EXISTS` |

`InboundEventRef` gets `orderId?` / `customerId?`; existing payment/stock code keeps passing `orderId`.

## Migration `20261119120000-AddCustomerRegistration.ts`

Up: the changes above. Down: delete identity rows from `processed_events`, restore CHECK and NOT NULL,
drop `customerId`, `name`, `email` (enum values left in place; Postgres cannot drop them).

## Messages

`UserRegisteredMessage` — see [contracts/user-registered.md](contracts/user-registered.md).
