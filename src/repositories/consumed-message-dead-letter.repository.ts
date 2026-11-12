import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  ConsumedMessageDeadLetterEntity,
  ConsumedMessageFailureType,
} from '../infra/database/entities/consumed-message-dead-letter.entity';
import { DeadLetterStatus } from '../infra/database/entities/dead-letter-status.enum';
import { RetryUpdate } from '../infra/dead-letter/retry-policy';
import { processNextDue } from './claim-next-due';

/** Where a consumed message came from, plus whatever identifiers could be read from it. */
export interface ConsumedMessageMeta {
  topic: string;
  partition: number;
  offset: string;
  messageKey: string | null;
  /** The raw value as UTF-8 text, verbatim; null for tombstones. */
  rawValue: string | null;
  eventId?: string;
  orderId?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stores consumed messages that could not be processed and claims them for the retry worker.
 * Separate from OrderDeadLetterRepository, which stores outbound events that failed to publish.
 */
@Injectable()
export class ConsumedMessageDeadLetterRepository {
  constructor(
    @InjectRepository(ConsumedMessageDeadLetterEntity)
    private readonly repository: Repository<ConsumedMessageDeadLetterEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /** Records a malformed message: it can never succeed, so it is stored EXHAUSTED (attempts 1). */
  async recordMalformed(meta: ConsumedMessageMeta, error: unknown): Promise<void> {
    await this.record(meta, ConsumedMessageFailureType.MALFORMED, error, 1);
  }

  /** Records a well-formed message whose processing failed on every attempt (due for retry). */
  async recordRetriesExhausted(
    meta: ConsumedMessageMeta,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    await this.record(meta, ConsumedMessageFailureType.RETRIES_EXHAUSTED, error, attempts);
  }

  /**
   * Claims the oldest due row with `FOR UPDATE SKIP LOCKED`, runs `handler` while holding the
   * lock and writes its update in the same transaction. A throwing handler rolls back.
   *
   * @returns `false` when nothing is due.
   */
  processNextDue(
    handler: (row: ConsumedMessageDeadLetterEntity) => Promise<RetryUpdate>,
  ): Promise<boolean> {
    return processNextDue(this.dataSource, ConsumedMessageDeadLetterEntity, handler);
  }

  private async record(
    meta: ConsumedMessageMeta,
    failureType: ConsumedMessageFailureType,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    await this.repository.insert({
      id: randomUUID(),
      topic: meta.topic,
      partition: meta.partition,
      offset: meta.offset,
      messageKey: meta.messageKey,
      rawValue: meta.rawValue,
      eventId: meta.eventId ?? null,
      orderId: meta.orderId ?? null,
      failureType,
      status:
        failureType === ConsumedMessageFailureType.MALFORMED
          ? DeadLetterStatus.EXHAUSTED
          : DeadLetterStatus.PENDING_RETRY,
      error: messageOf(error),
      attempts,
    });
  }
}
