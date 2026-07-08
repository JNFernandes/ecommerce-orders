import dataSource from '../typeorm.datasource';
import { CustomerEntity } from '../entities/customer.entity';

/** Seeds a fixed test customer so local dev / quickstart scenarios have a known existing customerId. */
export const SEED_CUSTOMER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

async function seed(): Promise<void> {
  const dataSourceInstance = await dataSource.initialize();
  const repository = dataSourceInstance.getRepository(CustomerEntity);

  const existing = await repository.findOneBy({ id: SEED_CUSTOMER_ID });
  if (!existing) {
    await repository.insert({ id: SEED_CUSTOMER_ID, createdAt: new Date() });
    // eslint-disable-next-line no-console
    console.log(`Seeded customer ${SEED_CUSTOMER_ID}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Customer ${SEED_CUSTOMER_ID} already seeded`);
  }

  await dataSourceInstance.destroy();
}

seed().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to seed customers', error);
  process.exit(1);
});
