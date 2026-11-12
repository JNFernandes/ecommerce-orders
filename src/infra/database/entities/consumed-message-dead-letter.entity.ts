import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { DeadLetterStatus } from './dead-letter-status.enum';

/** Why a consumed message was dead-lettered. */
export enum ConsumedMessageFailureType {
  /** Not JSON, or missing/invalid required fields. Never retried (stored as EXHAUSTED). */
  MALFORMED = 'MALFORMED',
  /** Well-formed, but processing kept failing until retries ran out. */
  RETRIES_EXHAUSTED = 'RETRIES_EXHAUSTED',
}

/**
 * A consumed Kafka message that could not be processed, retried by the dead-letter worker. Separate from
 * `order_dead_letters`, which holds outbound events that failed to publish.
 */
@Entity('consumed_message_dead_letters')
export class ConsumedMessageDeadLetterEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Source topic. */
  @Column({ type: 'varchar' })
  topic!: string;

  /** Source partition. */
  @Column({ type: 'int' })
  partition!: number;

  /** Source offset (int64 as a string). */
  @Column({ type: 'varchar' })
  offset!: string;

  /** Raw message key, if any. */
  @Column({ type: 'text', nullable: true })
  messageKey!: string | null;

  /** Raw message value, verbatim (even if not valid JSON); null for tombstones. */
  @Column({ type: 'text', nullable: true })
  rawValue!: string | null;

  /** The message's `eventId`, when it could be read as a UUID. */
  @Index('IDX_consumed_dead_letters_eventId')
  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  /** The message's `orderId`, when it could be read as a UUID. */
  @Column({ type: 'uuid', nullable: true })
  orderId!: string | null;

  /** Why the message was dead-lettered. */
  @Column({ type: 'varchar' })
  failureType!: ConsumedMessageFailureType;

  /** Last error message. */
  @Column({ type: 'text' })
  error!: string;

  /** Processing attempts made inside the consumer before dead-lettering (1 for malformed). */
  @Column({ type: 'int' })
  attempts!: number;

  /** Attempts made later by the retry worker (separate from `attempts`). */
  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  /** Retry state; only PENDING_RETRY rows are claimed by the retry worker. */
  @Column({
    type: 'enum',
    enum: DeadLetterStatus,
    enumName: 'dead_letter_status_enum',
    default: DeadLetterStatus.PENDING_RETRY,
  })
  status!: DeadLetterStatus;

  /** When the row is next due for a retry (due when ≤ now). */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextRetryAt!: Date;

  /** When the retry worker last attempted this row. */
  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  /** Error from the worker's last failed attempt (the original failure stays in `error`). */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** When a retry succeeded. */
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
