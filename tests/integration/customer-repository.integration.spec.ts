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
});
