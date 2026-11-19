import { Logger } from '@nestjs/common';
import { CreateCustomerCommand } from '../../../src/commands/create-customer.command';
import { CustomerValidationError } from '../../../src/domain/customer';
import { CustomerRepository } from '../../../src/repositories/customer.repository';
import { CreateCustomerService } from '../../../src/services/create-customer.service';
import { EventAlreadyProcessedError } from '../../../src/services/errors/outcome.errors';

const EVENT_ID = '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11';
const CUSTOMER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';
const REF = { eventId: EVENT_ID, topic: 'identity.user-registered', customerId: CUSTOMER_ID };

function build(createIfAbsent: jest.Mock): CreateCustomerService {
  return new CreateCustomerService({ createIfAbsent } as unknown as CustomerRepository);
}

describe('CreateCustomerService', () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    logSpies = (['log', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('should create a new customer with its processed-event ref', async () => {
    const createIfAbsent = jest.fn().mockResolvedValue({ created: true });

    const result = await build(createIfAbsent).execute(
      new CreateCustomerCommand(CUSTOMER_ID, 'Ada', 'ada@example.com', REF),
    );

    expect(result).toBe('CREATED');
    expect(createIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ id: CUSTOMER_ID, name: 'Ada', email: 'ada@example.com' }),
      REF,
    );
  });

  it('should reject an invalid email without touching the repository', async () => {
    const createIfAbsent = jest.fn();

    await expect(
      build(createIfAbsent).execute(new CreateCustomerCommand(CUSTOMER_ID, null, '  ', REF)),
    ).rejects.toBeInstanceOf(CustomerValidationError);
    expect(createIfAbsent).not.toHaveBeenCalled();
  });

  it('should treat an already processed eventId as success', async () => {
    const createIfAbsent = jest.fn().mockRejectedValue(new EventAlreadyProcessedError(EVENT_ID));

    const result = await build(createIfAbsent).execute(
      new CreateCustomerCommand(CUSTOMER_ID, null, 'ada@example.com', REF),
    );

    expect(result).toBe('ALREADY_PROCESSED');
  });
});
