import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetOrderArgs } from '../../../src/dto/graphql/get-order.args';

async function invalidProperties(orderId: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(GetOrderArgs, { orderId }));
  return errors.map((error) => error.property);
}

describe('GetOrderArgs validation', () => {
  it.each([
    ['a lowercase UUID', 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'],
    ['an uppercase UUID', 'B3F1C2D4-5E6F-4A7B-8C9D-0E1F2A3B4C5D'],
  ])('should accept %s', async (_label, orderId) => {
    expect(await invalidProperties(orderId)).toEqual([]);
  });

  it.each([['abc'], [''], ['123'], ['b3f1c2d4-5e6f-4a7b-8c9d']])(
    'should reject %j',
    async (orderId) => {
      expect(await invalidProperties(orderId)).toEqual(['orderId']);
    },
  );
});
