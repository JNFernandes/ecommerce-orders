import {
  MalformedPaymentMessageError,
  PAYMENT_FAILED_TOPIC,
  PAYMENT_PROCESSED_TOPIC,
  parsePaymentMessage,
} from '../../../src/infra/kafka/payment-message.parser';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';

const EVENT_ID = '9b2e4f1a-8c3d-4e5f-a6b7-c8d9e0f1a2b3';
const PAYMENT_ID = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const ORDER_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function processedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    occurredAt: '2026-07-09T14:32:01Z',
    aggregateId: PAYMENT_ID,
    version: 1,
    orderId: ORDER_ID,
    amount: 129.99,
    currency: 'USD',
    processedAt: '2026-07-09T14:32:01Z',
    ...overrides,
  };
}

function failedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    occurredAt: '2026-07-09T14:32:01Z',
    aggregateId: PAYMENT_ID,
    version: 1,
    orderId: ORDER_ID,
    reason: 'Amount exceeds threshold',
    failedAt: '2026-07-09T14:32:01Z',
    ...overrides,
  };
}

function buffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function expectMalformed(topic: string, raw: Buffer | null): MalformedPaymentMessageError {
  try {
    parsePaymentMessage(topic, raw);
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedPaymentMessageError);
    return error as MalformedPaymentMessageError;
  }
  throw new Error('expected MalformedPaymentMessageError');
}

describe('parsePaymentMessage', () => {
  it('should parse a valid payment-processed message into a PROCESSED outcome keyed by orderId', () => {
    const parsed = parsePaymentMessage(PAYMENT_PROCESSED_TOPIC, buffer(processedPayload()));

    expect(parsed.outcome).toBe(PaymentOutcome.PROCESSED);
    expect(parsed.inboundEvent).toEqual({
      eventId: EVENT_ID,
      topic: PAYMENT_PROCESSED_TOPIC,
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
    });
    expect(parsed.reason).toBeUndefined();
  });

  it('should parse a valid payment-failed message with its reason', () => {
    const parsed = parsePaymentMessage(PAYMENT_FAILED_TOPIC, buffer(failedPayload()));

    expect(parsed.outcome).toBe(PaymentOutcome.FAILED);
    expect(parsed.inboundEvent.orderId).toBe(ORDER_ID);
    expect(parsed.inboundEvent.paymentId).toBe(PAYMENT_ID);
    expect(parsed.reason).toBe('Amount exceeds threshold');
  });

  it.each([
    ['missing', { reason: undefined }],
    ['null', { reason: null }],
  ])('should normalise a %s reason to an empty string', (_label, overrides) => {
    const parsed = parsePaymentMessage(PAYMENT_FAILED_TOPIC, buffer(failedPayload(overrides)));

    expect(parsed.reason).toBe('');
  });

  it('should ignore unknown extra fields', () => {
    const parsed = parsePaymentMessage(
      PAYMENT_PROCESSED_TOPIC,
      buffer(processedPayload({ somethingNew: 'x' })),
    );

    expect(parsed.inboundEvent.orderId).toBe(ORDER_ID);
  });

  it('should throw MalformedPaymentMessageError when the value is not valid JSON', () => {
    const error = expectMalformed(PAYMENT_PROCESSED_TOPIC, Buffer.from('not json'));

    expect(error.eventId).toBeUndefined();
    expect(error.orderId).toBeUndefined();
  });

  it('should throw MalformedPaymentMessageError when the value is null', () => {
    expectMalformed(PAYMENT_PROCESSED_TOPIC, null);
  });

  it('should throw MalformedPaymentMessageError when the JSON is not an object', () => {
    expectMalformed(PAYMENT_PROCESSED_TOPIC, Buffer.from('42'));
  });

  it('should throw MalformedPaymentMessageError when eventId is missing, keeping the orderId it could read', () => {
    const error = expectMalformed(
      PAYMENT_PROCESSED_TOPIC,
      buffer(processedPayload({ eventId: undefined })),
    );

    expect(error.eventId).toBeUndefined();
    expect(error.orderId).toBe(ORDER_ID);
  });

  it('should throw MalformedPaymentMessageError when orderId is not a UUID, keeping the eventId it could read', () => {
    const error = expectMalformed(
      PAYMENT_PROCESSED_TOPIC,
      buffer(processedPayload({ orderId: 'order-1' })),
    );

    expect(error.eventId).toBe(EVENT_ID);
    expect(error.orderId).toBeUndefined();
  });

  it('should throw MalformedPaymentMessageError when aggregateId is missing', () => {
    expectMalformed(PAYMENT_PROCESSED_TOPIC, buffer(processedPayload({ aggregateId: undefined })));
  });

  it('should throw MalformedPaymentMessageError when version is not 1', () => {
    expectMalformed(PAYMENT_PROCESSED_TOPIC, buffer(processedPayload({ version: 2 })));
  });

  it('should throw MalformedPaymentMessageError when reason is not a string', () => {
    expectMalformed(PAYMENT_FAILED_TOPIC, buffer(failedPayload({ reason: 123 })));
  });

  it('should throw MalformedPaymentMessageError for an unknown topic', () => {
    expectMalformed('payments.payment-refunded', buffer(processedPayload()));
  });
});
