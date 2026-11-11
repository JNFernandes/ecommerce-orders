import {
  ORDER_EVENT_TOPICS,
  parseOrderEventMessage,
} from '../../../src/infra/kafka/order-event-message.parser';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  ORDER_PLACED_TOPIC,
} from '../../../src/infra/kafka/order-events.producer';

const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OCCURRED_AT = '2026-11-11T16:49:35.960Z';

function placed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    occurredAt: OCCURRED_AT,
    aggregateId: ORDER_ID,
    version: 1,
    customerId: CUSTOMER_ID,
    items: [{ productId: 'p-1', quantity: 2, unitPrice: 64.99 }],
    totalAmount: 129.98,
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    occurredAt: OCCURRED_AT,
    aggregateId: ORDER_ID,
    version: 1,
    customerId: CUSTOMER_ID,
    ...overrides,
  };
}

function buf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function expectMalformed(topic: string, value: Buffer | null): MalformedMessageError {
  try {
    parseOrderEventMessage(topic, value);
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedMessageError);
    return error as MalformedMessageError;
  }
  throw new Error('expected MalformedMessageError');
}

describe('parseOrderEventMessage', () => {
  it('should list the three order topics', () => {
    expect([...ORDER_EVENT_TOPICS].sort()).toEqual(
      [ORDER_CANCELLED_TOPIC, ORDER_CONFIRMED_TOPIC, ORDER_PLACED_TOPIC].sort(),
    );
  });

  it('should parse an OrderPlaced message, taking orderId from aggregateId', () => {
    expect(parseOrderEventMessage(ORDER_PLACED_TOPIC, buf(placed()))).toEqual({
      type: 'OrderPlaced',
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      occurredAt: new Date(OCCURRED_AT),
      customerId: CUSTOMER_ID,
      items: [{ productId: 'p-1', quantity: 2, unitPrice: 64.99 }],
      totalAmount: 129.98,
    });
  });

  it('should parse an OrderConfirmed message', () => {
    expect(parseOrderEventMessage(ORDER_CONFIRMED_TOPIC, buf(terminal()))).toEqual({
      type: 'OrderConfirmed',
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      occurredAt: new Date(OCCURRED_AT),
      customerId: CUSTOMER_ID,
    });
  });

  it('should parse an OrderCancelled message with its reason', () => {
    expect(
      parseOrderEventMessage(ORDER_CANCELLED_TOPIC, buf(terminal({ reason: 'too expensive' }))),
    ).toEqual({
      type: 'OrderCancelled',
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      occurredAt: new Date(OCCURRED_AT),
      customerId: CUSTOMER_ID,
      reason: 'too expensive',
    });
  });

  it.each([
    ['absent', {}],
    ['null', { reason: null }],
  ])('should map a %s cancellation reason to null', (_label, overrides) => {
    const event = parseOrderEventMessage(ORDER_CANCELLED_TOPIC, buf(terminal(overrides)));

    expect(event).toMatchObject({ type: 'OrderCancelled', reason: null });
  });

  it('should keep an empty-string cancellation reason', () => {
    const event = parseOrderEventMessage(ORDER_CANCELLED_TOPIC, buf(terminal({ reason: '' })));

    expect(event).toMatchObject({ reason: '' });
  });

  it('should ignore unknown extra fields', () => {
    const event = parseOrderEventMessage(ORDER_CONFIRMED_TOPIC, buf(terminal({ extra: 1 })));

    expect(event).not.toHaveProperty('extra');
  });

  it.each([
    ['invalid JSON', Buffer.from('not json')],
    ['a null value', null],
    ['a JSON array', Buffer.from('[1,2]')],
  ])('should reject %s', (_label, value) => {
    const error = expectMalformed(ORDER_PLACED_TOPIC, value);

    expect(error.eventId).toBeUndefined();
  });

  it.each([
    ['missing eventId', { eventId: undefined }],
    ['non-UUID aggregateId', { aggregateId: 'order-1' }],
    ['bad occurredAt', { occurredAt: 'yesterday' }],
    ['version 2', { version: 2 }],
    ['missing customerId', { customerId: undefined }],
    ['empty items', { items: [] }],
    ['quantity 0', { items: [{ productId: 'p-1', quantity: 0, unitPrice: 1 }] }],
    ['fractional quantity', { items: [{ productId: 'p-1', quantity: 1.5, unitPrice: 1 }] }],
    ['negative unitPrice', { items: [{ productId: 'p-1', quantity: 1, unitPrice: -1 }] }],
    ['missing productId', { items: [{ quantity: 1, unitPrice: 1 }] }],
    ['missing totalAmount', { totalAmount: undefined }],
  ])('should reject an OrderPlaced with %s', (_label, overrides) => {
    expectMalformed(ORDER_PLACED_TOPIC, buf(placed(overrides)));
  });

  it('should reject an OrderCancelled whose reason is not a string', () => {
    expectMalformed(ORDER_CANCELLED_TOPIC, buf(terminal({ reason: 5 })));
  });

  it('should reject an unknown topic', () => {
    expectMalformed('orders.order-shipped', buf(terminal()));
  });

  it('should keep the eventId and order id it could read on the error', () => {
    const error = expectMalformed(ORDER_PLACED_TOPIC, buf(placed({ version: 2 })));

    expect(error.eventId).toBe(EVENT_ID);
    expect(error.orderId).toBe(ORDER_ID);
  });
});
