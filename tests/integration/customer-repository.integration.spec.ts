import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Customer } from '../../src/domain/customer';
import { InboundEventRef } from '../../src/commands/inbound-event-ref';
import { CustomerEntity } from '../../src/infra/database/entities/customer.entity';
import {
  ProcessedEventEntity,
  ProcessedEventOutcome,
} from '../../src/infra/database/entities/processed-event.entity';
import { CustomerRepository } from '../../src/repositories/customer.repository';
import { EventAlreadyProcessedError } from '../../src/services/errors/outcome.errors';

jest.setTimeout(180_000);

describe('CustomerRepository.createIfAbsent (integration, real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: CustomerRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [CustomerEntity, ProcessedEventEntity],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new CustomerRepository(dataSource.getRepository(CustomerEntity), dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  function refFor(customerId: string): InboundEventRef {
    return { eventId: randomUUID(), topic: 'identity.user-registered', customerId };
  }

  it('should create the customer with name and email and record CUSTOMER_CREATED', async () => {
    const customer = Customer.register({
      id: randomUUID(),
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    const ref = refFor(customer.id);

    await expect(repository.createIfAbsent(customer, ref)).resolves.toEqual({ created: true });

    const row = await dataSource.getRepository(CustomerEntity).findOneBy({ id: customer.id });
    expect(row).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    const processed = await dataSource
      .getRepository(ProcessedEventEntity)
      .findOneBy({ eventId: ref.eventId });
    expect(processed).toMatchObject({
      topic: 'identity.user-registered',
      customerId: customer.id,
      orderId: null,
      paymentId: null,
      reservationId: null,
      outcome: ProcessedEventOutcome.CUSTOMER_CREATED,
    });
  });

  it('should leave an existing customer unchanged and record IGNORED_CUSTOMER_EXISTS', async () => {
    const id = randomUUID();
    await repository.createIfAbsent(
      Customer.register({ id, name: 'Ada', email: 'ada@example.com' }),
      refFor(id),
    );
    const ref = refFor(id);

    await expect(
      repository.createIfAbsent(
        Customer.register({ id, name: 'Other', email: 'other@example.com' }),
        ref,
      ),
    ).resolves.toEqual({ created: false });

    expect(await dataSource.getRepository(CustomerEntity).findOneBy({ id })).toMatchObject({
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(
      await dataSource.getRepository(ProcessedEventEntity).findOneBy({ eventId: ref.eventId }),
    ).toMatchObject({ outcome: ProcessedEventOutcome.IGNORED_CUSTOMER_EXISTS });
  });

  it('should throw EventAlreadyProcessedError for the same eventId twice', async () => {
    const customer = Customer.register({ id: randomUUID(), name: null, email: 'a@b.c' });
    const ref = refFor(customer.id);
    await repository.createIfAbsent(customer, ref);

    await expect(repository.createIfAbsent(customer, ref)).rejects.toBeInstanceOf(
      EventAlreadyProcessedError,
    );
  });

  it('should create one row when two registrations for one id race', async () => {
    const id = randomUUID();
    const results = await Promise.all([
      repository.createIfAbsent(Customer.register({ id, name: 'A', email: 'a@b.c' }), refFor(id)),
      repository.createIfAbsent(Customer.register({ id, name: 'B', email: 'b@b.c' }), refFor(id)),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(await dataSource.getRepository(CustomerEntity).countBy({ id })).toBe(1);
  });
});
