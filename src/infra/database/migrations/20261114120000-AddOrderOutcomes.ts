import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-09: an order is confirmed only when the payment is processed and the stock is reserved.
 * Adds the payment and stock outcomes to `orders` (backfilling CONFIRMED orders as both
 * positive), and lets `processed_events` record stock messages: their source id is a
 * reservation id, not a payment id.
 */
export class AddOrderOutcomes20261114120000 implements MigrationInterface {
  name = 'AddOrderOutcomes20261114120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "order_payment_outcome_enum" AS ENUM ('PENDING', 'PROCESSED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "order_stock_outcome_enum" AS ENUM ('PENDING', 'RESERVED', 'REJECTED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "paymentOutcome" "order_payment_outcome_enum" NOT NULL DEFAULT 'PENDING'`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "stockOutcome" "order_stock_outcome_enum" NOT NULL DEFAULT 'PENDING'`,
    );
    // Development database: orders confirmed before US-09 count as paid and reserved; every
    // other order keeps both outcomes PENDING.
    await queryRunner.query(
      `UPDATE "orders" SET "paymentOutcome" = 'PROCESSED', "stockOutcome" = 'RESERVED' ` +
        `WHERE "status" = 'CONFIRMED'`,
    );

    await queryRunner.query(
      `ALTER TABLE "processed_events" ALTER COLUMN "paymentId" DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "processed_events" ADD "reservationId" uuid NULL`);
    await queryRunner.query(
      `ALTER TABLE "processed_events" ADD CONSTRAINT "CHK_processed_events_one_source_id" ` +
        `CHECK (num_nonnulls("paymentId", "reservationId") = 1)`,
    );

    await queryRunner.query(`ALTER TYPE "processed_event_outcome_enum" ADD VALUE 'RECORDED'`);
    await queryRunner.query(
      `ALTER TYPE "processed_event_outcome_enum" ADD VALUE 'IGNORED_DUPLICATE'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL cannot drop enum values: recreate the type without the two US-09 values,
    // after removing the rows that use them.
    await queryRunner.query(
      `DELETE FROM "processed_events" WHERE "outcome" IN ('RECORDED', 'IGNORED_DUPLICATE')`,
    );
    await queryRunner.query(
      `ALTER TYPE "processed_event_outcome_enum" RENAME TO "processed_event_outcome_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "processed_event_outcome_enum" AS ENUM (` +
        `'CONFIRMED', 'CANCELLED', 'IGNORED_ALREADY_CONFIRMED', ` +
        `'IGNORED_ALREADY_CANCELLED', 'IGNORED_CONFLICT')`,
    );
    await queryRunner.query(
      `ALTER TABLE "processed_events" ALTER COLUMN "outcome" TYPE "processed_event_outcome_enum" ` +
        `USING "outcome"::text::"processed_event_outcome_enum"`,
    );
    await queryRunner.query(`DROP TYPE "processed_event_outcome_enum_old"`);

    // Stock messages have no payment id, so they cannot survive "paymentId" NOT NULL.
    await queryRunner.query(
      `ALTER TABLE "processed_events" DROP CONSTRAINT "CHK_processed_events_one_source_id"`,
    );
    await queryRunner.query(`DELETE FROM "processed_events" WHERE "paymentId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "processed_events" DROP COLUMN "reservationId"`);
    await queryRunner.query(`ALTER TABLE "processed_events" ALTER COLUMN "paymentId" SET NOT NULL`);

    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "stockOutcome"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "paymentOutcome"`);
    await queryRunner.query(`DROP TYPE "order_stock_outcome_enum"`);
    await queryRunner.query(`DROP TYPE "order_payment_outcome_enum"`);
  }
}
