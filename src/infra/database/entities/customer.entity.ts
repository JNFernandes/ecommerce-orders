import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A customer, created from identity.user-registered (US-10). Never updated or deleted. */
@Entity('customers')
export class CustomerEntity {
  /** The event's `customerId` (never its `aggregateId`, the user id). */
  @PrimaryColumn('uuid')
  id!: string;

  /** Display name as received; null when absent or for rows created before US-10. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  name!: string | null;

  /** Email as received; null only for rows created before US-10. */
  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
