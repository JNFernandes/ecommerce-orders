import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InboundEventRef } from '../commands/inbound-event-ref';
import { Customer } from '../domain/customer';
import { CustomerEntity } from '../infra/database/entities/customer.entity';
import {
  ProcessedEventEntity,
  ProcessedEventOutcome,
} from '../infra/database/entities/processed-event.entity';
import { EventAlreadyProcessedError } from '../services/errors/outcome.errors';
import { isUniqueViolation } from './errors/is-unique-violation';

/** Persistence for customers: existence checks for the write path, creation for US-10. */
@Injectable()
export class CustomerRepository {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly repository: Repository<CustomerEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /** True if a customer with this id exists. */
  async existsById(customerId: string): Promise<boolean> {
    const count = await this.repository.countBy({ id: customerId });
    return count > 0;
  }

  /**
   * Inserts the customer unless one with the same id exists (an existing row is left unchanged),
   * and records the event in `processed_events` in the same transaction.
   *
   * @returns `created: true` if the row was inserted, `false` if the customer already existed.
   * @throws EventAlreadyProcessedError if the event's `eventId` is already recorded.
   */
  async createIfAbsent(customer: Customer, ref: InboundEventRef): Promise<{ created: boolean }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const result = await manager
          .createQueryBuilder()
          .insert()
          .into(CustomerEntity)
          .values({ id: customer.id, name: customer.name, email: customer.email })
          .orIgnore()
          .returning(['id'])
          .execute();
        const created = (result.raw as unknown[]).length === 1;

        await manager.insert(ProcessedEventEntity, {
          eventId: ref.eventId,
          topic: ref.topic,
          orderId: null,
          customerId: customer.id,
          paymentId: null,
          reservationId: null,
          outcome: created
            ? ProcessedEventOutcome.CUSTOMER_CREATED
            : ProcessedEventOutcome.IGNORED_CUSTOMER_EXISTS,
        });
        return { created };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EventAlreadyProcessedError(ref.eventId);
      }
      throw error;
    }
  }
}
