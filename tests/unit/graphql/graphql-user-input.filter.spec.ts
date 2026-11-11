import { BadRequestException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { GraphQLUserInputFilter } from '../../../src/graphql/graphql-user-input.filter';
import { ReadModelUnavailableError } from '../../../src/read-model/errors';

function caught(exception: unknown): unknown {
  try {
    new GraphQLUserInputFilter().catch(exception);
  } catch (error) {
    return error;
  }
  throw new Error('expected the filter to throw');
}

describe('GraphQLUserInputFilter', () => {
  it('should turn a validation BadRequestException into BAD_USER_INPUT with every message', () => {
    const error = caught(
      new BadRequestException([
        'limit must not be greater than 100',
        'offset must not be less than 0',
      ]),
    ) as GraphQLError;

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions.code).toBe('BAD_USER_INPUT');
    expect(error.message).toBe(
      'limit must not be greater than 100; offset must not be less than 0',
    );
    expect(error.extensions.validationErrors).toEqual([
      'limit must not be greater than 100',
      'offset must not be less than 0',
    ]);
  });

  it('should turn a BadRequestException with a plain message into BAD_USER_INPUT', () => {
    const error = caught(new BadRequestException('customerId must be a UUID')) as GraphQLError;

    expect(error.extensions.code).toBe('BAD_USER_INPUT');
    expect(error.message).toBe('customerId must be a UUID');
    expect(error.extensions.validationErrors).toEqual(['customerId must be a UUID']);
  });

  it('should report a read-model outage as SERVICE_UNAVAILABLE without internal details', () => {
    const error = caught(
      new ReadModelUnavailableError(new Error('Authentication failed. mongodb://user:pass@host')),
    ) as GraphQLError;

    expect(error.extensions.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.message).toBe('Order data is temporarily unavailable, please retry');
    expect(JSON.stringify(error.toJSON())).not.toMatch(/Authentication|mongodb|pass/);
  });

  it('should rethrow any other error unchanged', () => {
    const other = new Error('unexpected');

    expect(caught(other)).toBe(other);
  });
});
