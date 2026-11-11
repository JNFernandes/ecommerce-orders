import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** Why a consumed message was dead-lettered. */
export enum ConsumedMessageFailureType {
  /** Not JSON, or missing/invalid required fields. Never retried. */
  MALFORMED = 'MALFORMED',
  /** Well-formed, but processing kept failing until retries ran out. */
  RETRIES_EXHAUSTED = 'RETRIES_EXHAUSTED',
}

/**
 * A consumed Kafka message that could not be processed, kept for an operator. Separate from
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

  /** Processing attempts made (1 for malformed messages). */
  @Column({ type: 'int' })
  attempts!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
