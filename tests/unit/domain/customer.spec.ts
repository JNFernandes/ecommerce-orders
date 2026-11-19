import { Customer, CustomerValidationError } from '../../../src/domain/customer';

const CUSTOMER_ID = '3f1c2b11-9b1f-4a52-9a1f-0f6c3f1c2d0c';

describe('Customer.register', () => {
  it('creates a customer with the given id, name and email', () => {
    const customer = Customer.register({
      id: CUSTOMER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });

    expect(customer.id).toBe(CUSTOMER_ID);
    expect(customer.name).toBe('Ada Lovelace');
    expect(customer.email).toBe('ada@example.com');
  });

  it('accepts a null name', () => {
    const customer = Customer.register({ id: CUSTOMER_ID, name: null, email: 'ada@example.com' });

    expect(customer.name).toBeNull();
  });

  it('accepts a name of exactly 100 characters', () => {
    const name = 'a'.repeat(100);

    expect(Customer.register({ id: CUSTOMER_ID, name, email: 'ada@example.com' }).name).toBe(name);
  });

  it.each(['', '   '])('rejects an empty email (%j)', (email) => {
    expect(() => Customer.register({ id: CUSTOMER_ID, name: null, email })).toThrow(
      CustomerValidationError,
    );
  });

  it.each(['not-a-uuid', ''])('rejects an id that is not a UUID (%j)', (id) => {
    expect(() => Customer.register({ id, name: null, email: 'ada@example.com' })).toThrow(
      CustomerValidationError,
    );
  });

  it('rejects a name longer than 100 characters', () => {
    expect(() =>
      Customer.register({ id: CUSTOMER_ID, name: 'a'.repeat(101), email: 'ada@example.com' }),
    ).toThrow(CustomerValidationError);
  });
});
