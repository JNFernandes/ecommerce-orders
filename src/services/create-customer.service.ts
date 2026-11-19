import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateCustomerCommand } from '../commands/create-customer.command';
import { describeInboundEvent } from '../commands/inbound-event-ref';
import { Customer } from '../domain/customer';
import { CustomerRepository } from '../repositories/customer.repository';
import { EventAlreadyProcessedError } from './errors/outcome.errors';

/** What CreateCustomerService did with a registration. */
export type CreateCustomerResult = 'CREATED' | 'ALREADY_EXISTS' | 'ALREADY_PROCESSED';

/**
 * Creates the customer announced by `identity.user-registered` (US-10): validates it in the
 * domain (`Customer.register`) and inserts it idempotently with its processed-event record.
 * An existing customer is left unchanged. Publishes nothing.
 */
@CommandHandler(CreateCustomerCommand)
export class CreateCustomerService implements ICommandHandler<
  CreateCustomerCommand,
  CreateCustomerResult
> {
  private readonly logger = new Logger(CreateCustomerService.name);

  constructor(private readonly customers: CustomerRepository) {}

  /**
   * @throws CustomerValidationError if the registration violates a domain invariant.
   */
  async execute(command: CreateCustomerCommand): Promise<CreateCustomerResult> {
    const customer = Customer.register({
      id: command.customerId,
      name: command.name,
      email: command.email,
    });
    const event = describeInboundEvent(command.ref);

    try {
      const { created } = await this.customers.createIfAbsent(customer, command.ref);
      if (created) {
        this.logger.log(`customer created; ${event}`);
        return 'CREATED';
      }
      this.logger.log(`customer already exists (no-op); ${event}`);
      return 'ALREADY_EXISTS';
    } catch (error) {
      if (error instanceof EventAlreadyProcessedError) {
        this.logger.debug(`skipping already processed event; ${event}`);
        return 'ALREADY_PROCESSED';
      }
      throw error;
    }
  }
}
