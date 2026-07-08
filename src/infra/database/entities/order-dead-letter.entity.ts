import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Captures an OrderPlaced event that failed to publish to Kafka, for later retry. */
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

  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
