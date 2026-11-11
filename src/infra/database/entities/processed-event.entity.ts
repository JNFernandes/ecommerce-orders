import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** What the Orders service did with a consumed payment event. */
export enum ProcessedEventOutcome {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  IGNORED_ALREADY_CONFIRMED = 'IGNORED_ALREADY_CONFIRMED',
  IGNORED_ALREADY_CANCELLED = 'IGNORED_ALREADY_CANCELLED',
  IGNORED_CONFLICT = 'IGNORED_CONFLICT',
}

/**
 * Idempotency record for a consumed event: one row per `eventId` that has been handled
 * (state change or no-op). The primary key on `eventId` is what makes redelivery safe.
 */
@Entity('processed_events')
export class ProcessedEventEntity {
  /** The consumed event's `eventId` (dedupe key). */
  @PrimaryColumn('uuid')
  eventId!: string;

  /** Topic the event was consumed from. */
  @Column({ type: 'varchar' })
  topic!: string;

  /** The order the event referenced (its `orderId` field). */
  @Index('IDX_processed_events_orderId')
  @Column({ type: 'uuid' })
  orderId!: string;

  /** The payment event's `aggregateId` (the payment id, never an order id). */
  @Column({ type: 'uuid' })
  paymentId!: string;

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
