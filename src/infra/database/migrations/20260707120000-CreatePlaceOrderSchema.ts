import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePlaceOrderSchema20260707120000 implements MigrationInterface {
  name = 'CreatePlaceOrderSchema20260707120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(
      `CREATE TYPE "order_status_enum" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customers" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "status" "order_status_enum" NOT NULL DEFAULT 'PENDING',
        "totalAmount" decimal(12,2) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orders" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "order_items" (
        "id" uuid NOT NULL,
        "orderId" uuid NOT NULL,
        "productId" varchar NOT NULL,
        "quantity" int NOT NULL,
        "unitPrice" decimal(10,2) NOT NULL,
        "subtotal" decimal(12,2) NOT NULL,
        CONSTRAINT "PK_order_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_order_items_order_product" UNIQUE ("orderId", "productId"),
        CONSTRAINT "FK_order_items_order" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "order_dead_letters" (
        "id" uuid NOT NULL,
        "eventId" uuid NOT NULL,
        "topic" varchar NOT NULL,
        "payload" jsonb NOT NULL,
        "error" text NOT NULL,
        "retryCount" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_dead_letters" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "order_dead_letters"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TABLE "customers"`);
    await queryRunner.query(`DROP TYPE "order_status_enum"`);
  }
}
