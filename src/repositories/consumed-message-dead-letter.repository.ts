import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  ConsumedMessageDeadLetterEntity,
  ConsumedMessageFailureType,
} from '../infra/database/entities/consumed-message-dead-letter.entity';

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
 * Stores consumed messages that could not be processed, for an operator to inspect. Separate
 * from OrderDeadLetterRepository, which stores outbound events that failed to publish.
 */
@Injectable()
export class ConsumedMessageDeadLetterRepository {
  constructor(
    @InjectRepository(ConsumedMessageDeadLetterEntity)
    private readonly repository: Repository<ConsumedMessageDeadLetterEntity>,
  ) {}

  /** Records a malformed message (never retried, so `attempts` is 1). */
  async recordMalformed(meta: ConsumedMessageMeta, error: unknown): Promise<void> {
    await this.record(meta, ConsumedMessageFailureType.MALFORMED, error, 1);
  }

  /** Records a well-formed message whose processing failed on every attempt. */
  async recordRetriesExhausted(
    meta: ConsumedMessageMeta,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    await this.record(meta, ConsumedMessageFailureType.RETRIES_EXHAUSTED, error, attempts);
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
      error: messageOf(error),
      attempts,
    });
  }
}
