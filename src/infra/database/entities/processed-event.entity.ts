import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * What the Orders service did with a consumed event. For payment and stock events, same values
 * as the domain's `OutcomeRecord`, which decides them; the `CUSTOMER_*` values are for identity
 * events.
 */
export enum ProcessedEventOutcome {
  /** First positive outcome stored; the order is still PENDING (US-09). */
  RECORDED = 'RECORDED',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  /** The same outcome was already recorded on the PENDING order (US-09). */
  IGNORED_DUPLICATE = 'IGNORED_DUPLICATE',
  IGNORED_ALREADY_CONFIRMED = 'IGNORED_ALREADY_CONFIRMED',
  IGNORED_ALREADY_CANCELLED = 'IGNORED_ALREADY_CANCELLED',
  IGNORED_CONFLICT = 'IGNORED_CONFLICT',
  /** An identity.user-registered event created the customer (US-10). */
  CUSTOMER_CREATED = 'CUSTOMER_CREATED',
  /** An identity.user-registered event for a customer that already exists: no-op (US-10). */
  IGNORED_CUSTOMER_EXISTS = 'IGNORED_CUSTOMER_EXISTS',
}

/**
 * Idempotency record for a consumed event: one row per `eventId` that has been handled
 * (state change or no-op). The primary key on `eventId` is what makes redelivery safe.
 */
@Entity('processed_events')
@Check(
  'CHK_processed_events_one_source_id',
  'num_nonnulls("paymentId", "reservationId", "customerId") = 1',
)
@Check('CHK_processed_events_order_or_customer', '("customerId" IS NULL) = ("orderId" IS NOT NULL)')
export class ProcessedEventEntity {
  /** The consumed event's `eventId` (dedupe key). */
  @PrimaryColumn('uuid')
  eventId!: string;

  /** Topic the event was consumed from. */
  @Column({ type: 'varchar' })
  topic!: string;

  /** The order the event referenced (its `orderId` field). Null for identity events. */
  @Index('IDX_processed_events_orderId')
  @Column({ type: 'uuid', nullable: true })
  orderId!: string | null;

  /**
   * A payment event's `aggregateId` (the payment id, never an order id). Null for stock events.
   * Exactly one of `paymentId` / `reservationId` / `customerId` is set (database CHECK).
   */
  @Column({ type: 'uuid', nullable: true })
  paymentId!: string | null;

  /** A stock event's `aggregateId` (the reservation id, never an order id). Null otherwise. */
  @Column({ type: 'uuid', nullable: true })
  reservationId!: string | null;

  /**
   * An identity event's `customerId` (US-10); its `aggregateId`, the user id, is never stored.
   * Set exactly when `orderId` is null (database CHECK).
   */
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  /** What was done with the event. */
  @Column({
    type: 'enum',
    enum: ProcessedEventOutcome,
    enumName: 'processed_event_outcome_enum',
  })
  outcome!: ProcessedEventOutcome;

  /** When the event was processed. */
  @CreateDateColumn({ type: 'timestamptz' })
  processedAt!: Date;
}
