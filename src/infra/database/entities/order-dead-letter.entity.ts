import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { DeadLetterStatus } from './dead-letter-status.enum';

/** An order event that failed to publish to Kafka after its DB save, retried by the dead-letter worker. */
@Entity('order_dead_letters')
export class OrderDeadLetterEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'varchar' })
  topic!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text' })
  error!: string;

  /** Attempts made by the retry worker. */
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
