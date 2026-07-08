import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Minimal read-only reference row used only to verify a customer exists. */
@Entity('customers')
export class CustomerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
