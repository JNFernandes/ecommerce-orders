import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-10: customers are created from `identity.user-registered`. Adds `name` and `email` to
 * `customers` (nullable, so pre-US-10 rows stay valid), and lets `processed_events` record
 * identity messages: they carry a customer id instead of an order id.
 */
export class AddCustomerRegistration20261119120000 implements MigrationInterface {
  name = 'AddCustomerRegistration20261119120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" ADD "name" character varying(100) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD "email" character varying(320) NULL`);

    await queryRunner.query(`ALTER TABLE "processed_events" ALTER COLUMN "orderId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "processed_events" ADD "customerId" uuid NULL`);
    await queryRunner.query(
      `ALTER TABLE "processed_events" DROP CONSTRAINT "CHK_processed_events_one_source_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "processed_events" ADD CONSTRAINT "CHK_processed_events_one_source_id" ` +
        `CHECK (num_nonnulls("paymentId", "reservationId", "customerId") = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "processed_events" ADD CONSTRAINT "CHK_processed_events_order_or_customer" ` +
        `CHECK (("customerId" IS NULL) = ("orderId" IS NOT NULL))`,
    );

    await queryRunner.query(
      `ALTER TYPE "processed_event_outcome_enum" ADD VALUE 'CUSTOMER_CREATED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "processed_event_outcome_enum" ADD VALUE 'IGNORED_CUSTOMER_EXISTS'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Identity messages have no order id, so they cannot survive "orderId" NOT NULL. The two
    // enum values are left in place: PostgreSQL cannot drop them, and no row uses them anymore.
    await queryRunner.query(`DELETE FROM "processed_events" WHERE "customerId" IS NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "processed_events" DROP CONSTRAINT "CHK_processed_events_order_or_customer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "processed_events" DROP CONSTRAINT "CHK_processed_events_one_source_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "processed_events" ADD CONSTRAINT "CHK_processed_events_one_source_id" ` +
        `CHECK (num_nonnulls("paymentId", "reservationId") = 1)`,
    );
    await queryRunner.query(`ALTER TABLE "processed_events" DROP COLUMN "customerId"`);
    await queryRunner.query(`ALTER TABLE "processed_events" ALTER COLUMN "orderId" SET NOT NULL`);

    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "email"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "name"`);
  }
}
