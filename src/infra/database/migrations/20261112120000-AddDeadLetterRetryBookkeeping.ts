import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['order_dead_letters', 'consumed_message_dead_letters'] as const;

/**
 * US-08: retry bookkeeping on both dead-letter tables. Existing rows become PENDING_RETRY and due
 * now, except malformed inbound messages, which can never succeed and become EXHAUSTED.
 */
export class AddDeadLetterRetryBookkeeping20261112120000 implements MigrationInterface {
  name = 'AddDeadLetterRetryBookkeeping20261112120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "dead_letter_status_enum" AS ENUM ('PENDING_RETRY', 'RESOLVED', 'EXHAUSTED')`,
    );

    await queryRunner.query(
      `ALTER TABLE "consumed_message_dead_letters" ADD "retryCount" int NOT NULL DEFAULT 0`,
    );
    for (const table of TABLES) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD "status" "dead_letter_status_enum" NOT NULL DEFAULT 'PENDING_RETRY',
          ADD "nextRetryAt" timestamptz NOT NULL DEFAULT now(),
          ADD "lastAttemptAt" timestamptz NULL,
          ADD "lastError" text NULL,
          ADD "resolvedAt" timestamptz NULL
      `);
    }

    await queryRunner.query(
      `UPDATE "consumed_message_dead_letters" SET "status" = 'EXHAUSTED' WHERE "failureType" = 'MALFORMED'`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_order_dead_letters_due" ON "order_dead_letters" ("nextRetryAt", "createdAt") WHERE "status" = 'PENDING_RETRY'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_consumed_dead_letters_due" ON "consumed_message_dead_letters" ("nextRetryAt", "createdAt") WHERE "status" = 'PENDING_RETRY'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_consumed_dead_letters_due"`);
    await queryRunner.query(`DROP INDEX "IDX_order_dead_letters_due"`);
    for (const table of TABLES) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN "resolvedAt",
          DROP COLUMN "lastError",
          DROP COLUMN "lastAttemptAt",
          DROP COLUMN "nextRetryAt",
          DROP COLUMN "status"
      `);
    }
    await queryRunner.query(`ALTER TABLE "consumed_message_dead_letters" DROP COLUMN "retryCount"`);
    await queryRunner.query(`DROP TYPE "dead_letter_status_enum"`);
  }
}
