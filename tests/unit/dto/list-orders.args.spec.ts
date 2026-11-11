import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListOrdersArgs } from '../../../src/dto/graphql/list-orders.args';

async function invalidProperties(input: Record<string, unknown>): Promise<string[]> {
  const args = plainToInstance(ListOrdersArgs, { limit: 20, offset: 0, ...input });
  const errors = await validate(args);
  return errors.map((error) => error.property);
}

describe('ListOrdersArgs validation', () => {
  it.each([
    [{ limit: 1 }],
    [{ limit: 100 }],
    [{ offset: 0 }],
    [{ customerId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }],
    [{ status: 'CONFIRMED' }],
    [{}],
  ])('should accept %j', async (input) => {
    expect(await invalidProperties(input)).toEqual([]);
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ offset: -1 }, 'offset'],
    [{ customerId: 'abc' }, 'customerId'],
    [{ status: 'SHIPPED' }, 'status'],
  ])('should reject %j on %s', async (input, property) => {
    expect(await invalidProperties(input)).toEqual([property]);
  });

  it('should default limit to 20 and offset to 0', () => {
    const args = new ListOrdersArgs();

    expect(args.limit).toBe(20);
    expect(args.offset).toBe(0);
  });
});
