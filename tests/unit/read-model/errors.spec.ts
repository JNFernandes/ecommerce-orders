import {
  OrderViewConcurrencyError,
  ReadModelUnavailableError,
} from '../../../src/read-model/errors';

describe('read-model errors', () => {
  it('should describe a concurrent modification of a view', () => {
    const error = new OrderViewConcurrencyError('order-1');

    expect(error.name).toBe('OrderViewConcurrencyError');
    expect(error.orderId).toBe('order-1');
    expect(error.message).toContain('order-1');
  });

  it('should wrap the cause of an unavailable read model', () => {
    const cause = new Error('connect ECONNREFUSED');
    const error = new ReadModelUnavailableError(cause);

    expect(error.name).toBe('ReadModelUnavailableError');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('read model unavailable: connect ECONNREFUSED');
  });

  it('should describe a non-Error cause', () => {
    expect(new ReadModelUnavailableError('timeout').message).toBe(
      'read model unavailable: timeout',
    );
  });
});
