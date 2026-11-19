import {
  USER_REGISTERED_TOPIC,
  parseUserRegisteredMessage,
} from '../../../src/infra/kafka/user-registered-message.parser';

const EVENT_ID = '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11';
const USER_ID = '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33';
const CUSTOMER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';

function value(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: EVENT_ID,
      aggregateId: USER_ID,
      occurredAt: '2026-11-19T10:00:00.000Z',
      version: 1,
      customerId: CUSTOMER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      ...overrides,
    }),
  );
}

describe('parseUserRegisteredMessage', () => {
  it('should return the eventId, customerId, name and email of a valid message', () => {
    expect(parseUserRegisteredMessage(USER_REGISTERED_TOPIC, value())).toEqual({
      eventId: EVENT_ID,
      customerId: CUSTOMER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
  });

  it('should identify the customer by customerId, never by aggregateId', () => {
    const parsed = parseUserRegisteredMessage(USER_REGISTERED_TOPIC, value());

    expect(parsed.customerId).toBe(CUSTOMER_ID);
    expect(Object.values(parsed)).not.toContain(USER_ID);
  });

  it('should return a null name when the message has none', () => {
    const parsed = parseUserRegisteredMessage(USER_REGISTERED_TOPIC, value({ name: undefined }));

    expect(parsed.name).toBeNull();
  });
});
