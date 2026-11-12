import { DataSource, ObjectLiteral } from 'typeorm';
import { DeadLetterStatus } from '../infra/database/entities/dead-letter-status.enum';
import { RetryUpdate } from '../infra/dead-letter/retry-policy';

/**
 * Claims the oldest due `PENDING_RETRY` row of a dead-letter table and processes it, all in one
 * transaction:
 *
 * `SELECT … WHERE status = 'PENDING_RETRY' AND "nextRetryAt" <= now()
 *  ORDER BY "nextRetryAt", "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`
 *
 * The row lock is held while `handler` runs, so another instance skips the row instead of
 * processing it twice. The handler's update is written in the same transaction. If the handler
 * throws (or the process dies), the transaction rolls back and the row stays due, unchanged.
 *
 * @returns `false` when no row is due (or all due rows are locked), `true` once one is processed.
 */
export async function processNextDue<T extends { id: string }>(
  dataSource: DataSource,
  target: new () => T,
  handler: (row: T) => Promise<RetryUpdate>,
): Promise<boolean> {
  return dataSource.transaction(async (manager) => {
    const row = await manager
      .getRepository(target)
      .createQueryBuilder('dl')
      .where('dl.status = :status', { status: DeadLetterStatus.PENDING_RETRY })
      .andWhere('dl.nextRetryAt <= now()')
      .orderBy('dl.nextRetryAt', 'ASC')
      .addOrderBy('dl.createdAt', 'ASC')
      .limit(1)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getOne();
    if (row === null) {
      return false;
    }
    const update = await handler(row);
    // Typed as a plain object: TypeORM's partial-entity type does not resolve through a generic.
    const fields: ObjectLiteral = { ...update };
    await manager.getRepository<ObjectLiteral>(target).update(row.id, fields);
    return true;
  });
}
