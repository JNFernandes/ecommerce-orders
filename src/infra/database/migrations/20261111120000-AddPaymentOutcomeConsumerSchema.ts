import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * US-04: schema for consuming payment outcomes — the order's cancellation reason, the
 * processed-events idempotency table, and the consumed-message dead-letter table.
 */
export class AddPaymentOutcomeConsumerSchema20261111120000 implements MigrationInterface {
  name = 'AddPaymentOutcomeConsumerSchema20261111120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD "cancellationReason" text NULL`);

    await queryRunner.query(
      `CREATE TYPE "processed_event_outcome_enum" AS ENUM (` +
        `'CONFIRMED', 'CANCELLED', 'IGNORED_ALREADY_CONFIRMED', ` +
        `'IGNORED_ALREADY_CANCELLED', 'IGNORED_CONFLICT')`,
    );

    await queryRunner.query(`
      CREATE TABLE "processed_events" (
        "eventId" uuid NOT NULL,
        "topic" varchar NOT NULL,
        "orderId" uuid NOT NULL,
        "paymentId" uuid NOT NULL,
        "outcome" "processed_event_outcome_enum" NOT NULL,
        "processedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_processed_events" PRIMARY KEY ("eventId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_processed_events_orderId" ON "processed_events" ("orderId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "consumed_message_dead_letters" (
        "id" uuid NOT NULL,
        "topic" varchar NOT NULL,
        "partition" int NOT NULL,
        "offset" varchar NOT NULL,
        "messageKey" text NULL,
        "rawValue" text NULL,
        "eventId" uuid NULL,
        "orderId" uuid NULL,
        "failureType" varchar NOT NULL,
        "error" text NOT NULL,
        "attempts" int NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_consumed_message_dead_letters" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_consumed_dead_letters_eventId" ON "consumed_message_dead_letters" ("eventId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_consumed_dead_letters_eventId"`);
    await queryRunner.query(`DROP TABLE "consumed_message_dead_letters"`);
    await queryRunner.query(`DROP INDEX "IDX_processed_events_orderId"`);
    await queryRunner.query(`DROP TABLE "processed_events"`);
    await queryRunner.query(`DROP TYPE "processed_event_outcome_enum"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "cancellationReason"`);
  }
}
