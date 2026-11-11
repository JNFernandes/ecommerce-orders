import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
} from 'graphql';
import { buildOrdersSchema, printOrdersSchema } from '../../../src/graphql/print-schema';

jest.setTimeout(30_000);

const COMMITTED_SCHEMA = join(__dirname, '../../../docs/schema.gql');

function normalise(sdl: string): string {
  return sdl.replace(/\r\n/g, '\n').trimEnd();
}

/** Every schema element (type, field, argument, enum value) that lacks a description. */
function undescribed(schema: GraphQLSchema): string[] {
  const missing: string[] = [];
  const has = (description: string | null | undefined): boolean =>
    typeof description === 'string' && description.trim().length > 0;

  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || (isScalarType(type) && isSpecifiedScalarType(type))) {
      continue;
    }
    // Root operation types (Query) cannot carry a description in code-first Nest; their fields can.
    const isRootType = type === schema.getQueryType() || type === schema.getMutationType();
    if (!isRootType && !has(type.description)) missing.push(type.name);

    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (!has(field.description)) missing.push(`${type.name}.${field.name}`);
        for (const arg of field.args) {
          if (!has(arg.description)) missing.push(`${type.name}.${field.name}(${arg.name})`);
        }
      }
    }
    if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (!has(field.description)) missing.push(`${type.name}.${field.name}`);
      }
    }
    if (isEnumType(type)) {
      for (const value of type.getValues()) {
        if (!has(value.description)) missing.push(`${type.name}.${value.name}`);
      }
    }
  }
  return missing;
}

describe('GraphQL schema', () => {
  let printed: string;

  beforeAll(async () => {
    printed = await printOrdersSchema();
  });

  it('should match the committed docs/schema.gql (run `npm run schema:generate` after changes)', () => {
    expect(normalise(readFileSync(COMMITTED_SCHEMA, 'utf8'))).toBe(normalise(printed));
  });

  it('should describe every type, field, argument and enum value', async () => {
    expect(undescribed(await buildOrdersSchema())).toEqual([]);
  });

  it('should expose the orders query with its arguments and defaults', () => {
    expect(printed).toMatch(
      /orders\(\s*"""[^"]*"""\s*customerId: ID[\s\S]*limit: Int! = 20[\s\S]*offset: Int! = 0[\s\S]*status: OrderStatus\s*\): OrdersPage!/,
    );
  });
});
