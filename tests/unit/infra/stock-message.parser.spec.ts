import {
  MalformedStockMessageError,
  STOCK_REJECTED_TOPIC,
  STOCK_RESERVED_TOPIC,
  parseStockMessage,
} from '../../../src/infra/kafka/stock-message.parser';
import { MalformedMessageError } from '../../../src/infra/kafka/malformed-message.error';
import { StockOutcome } from '../../../src/domain/stock-outcome.enum';

const EVENT_ID = '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11';
const RESERVATION_ID = '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33';
const ORDER_ID = '4889fbea-c49f-4094-8ca9-45d79508477e';

function reservedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    aggregateId: RESERVATION_ID,
    occurredAt: '2026-11-14T10:00:01.000Z',
    version: 1,
    orderId: ORDER_ID,
    items: [{ productId: 'sku-1', quantity: 2 }],
    reservedAt: '2026-11-14T10:00:01.000Z',
    ...overrides,
  };
}

function rejectedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    aggregateId: RESERVATION_ID,
    occurredAt: '2026-11-14T10:00:01.000Z',
    version: 1,
    orderId: ORDER_ID,
    reason: 'insufficient stock',
    items: [{ productId: 'sku-1', requested: 5, available: 2 }],
    rejectedAt: '2026-11-14T10:00:01.000Z',
    ...overrides,
  };
}

function buffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function expectMalformed(topic: string, raw: Buffer | null): MalformedStockMessageError {
  try {
    parseStockMessage(topic, raw);
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedStockMessageError);
    expect(error).toBeInstanceOf(MalformedMessageError);
    return error as MalformedStockMessageError;
  }
  throw new Error('expected MalformedStockMessageError');
}

describe('parseStockMessage', () => {
  it('should parse a stock-reserved message into a RESERVED outcome keyed by orderId', () => {
    const parsed = parseStockMessage(STOCK_RESERVED_TOPIC, buffer(reservedPayload()));

    expect(parsed).toEqual({
      outcome: StockOutcome.RESERVED,
      inboundEvent: {
        eventId: EVENT_ID,
        topic: STOCK_RESERVED_TOPIC,
        orderId: ORDER_ID,
        reservationId: RESERVATION_ID,
      },
    });
  });

  it('should parse a stock-rejected message into a REJECTED outcome with its reason', () => {
    const parsed = parseStockMessage(STOCK_REJECTED_TOPIC, buffer(rejectedPayload()));

    expect(parsed).toEqual({
      outcome: StockOutcome.REJECTED,
      inboundEvent: {
        eventId: EVENT_ID,
        topic: STOCK_REJECTED_TOPIC,
        orderId: ORDER_ID,
        reservationId: RESERVATION_ID,
      },
      reason: 'insufficient stock',
    });
  });

  it('should take the order id from orderId and keep aggregateId only as the reservation id', () => {
    const parsed = parseStockMessage(STOCK_RESERVED_TOPIC, buffer(reservedPayload()));

    expect(parsed.inboundEvent.orderId).toBe(ORDER_ID);
    expect(parsed.inboundEvent.reservationId).toBe(RESERVATION_ID);
    expect(parsed.inboundEvent.orderId).not.toBe(RESERVATION_ID);
    expect(parsed.inboundEvent.paymentId).toBeUndefined();
  });

  it.each([
    ['missing', { reason: undefined }],
    ['null', { reason: null }],
  ])('should accept a stock-rejected message whose reason is %s', (_label, overrides) => {
    const parsed = parseStockMessage(STOCK_REJECTED_TOPIC, buffer(rejectedPayload(overrides)));

    expect(parsed.outcome).toBe(StockOutcome.REJECTED);
    expect(parsed.reason).toBeUndefined();
  });

  it('should ignore the item lists and timestamps it does not use', () => {
    const parsed = parseStockMessage(
      STOCK_RESERVED_TOPIC,
      buffer(reservedPayload({ items: 'not an array', reservedAt: 42 })),
    );

    expect(parsed.outcome).toBe(StockOutcome.RESERVED);
  });

  it('should reject an empty value', () => {
    expectMalformed(STOCK_RESERVED_TOPIC, null);
  });

  it('should reject a value that is not JSON', () => {
    expectMalformed(STOCK_RESERVED_TOPIC, Buffer.from('{not json'));
  });

  it('should reject a JSON value that is not an object', () => {
    expectMalformed(STOCK_RESERVED_TOPIC, buffer([1, 2, 3]));
  });

  it.each([
    ['eventId missing', { eventId: undefined }],
    ['eventId not a UUID', { eventId: 'abc' }],
    ['orderId missing', { orderId: undefined }],
    ['orderId not a UUID', { orderId: 'abc' }],
    ['aggregateId missing', { aggregateId: undefined }],
    ['aggregateId not a UUID', { aggregateId: 'abc' }],
    ['occurredAt missing', { occurredAt: undefined }],
    ['occurredAt not ISO 8601', { occurredAt: 'yesterday' }],
    ['version 2', { version: 2 }],
    ['version missing', { version: undefined }],
  ])('should reject a message with %s', (_label, overrides) => {
    expectMalformed(STOCK_RESERVED_TOPIC, buffer(reservedPayload(overrides)));
  });

  it('should reject a stock-rejected message whose reason is not a string', () => {
    expectMalformed(STOCK_REJECTED_TOPIC, buffer(rejectedPayload({ reason: 42 })));
  });

  it('should reject a message from a topic it does not handle', () => {
    expectMalformed('inventory.stock-released', buffer(reservedPayload()));
  });

  it('should carry the eventId and orderId it could read on a malformed message', () => {
    const error = expectMalformed(STOCK_RESERVED_TOPIC, buffer(reservedPayload({ version: 2 })));

    expect(error.eventId).toBe(EVENT_ID);
    expect(error.orderId).toBe(ORDER_ID);
  });
});
