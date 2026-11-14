import { describeInboundEvent } from '../../../src/commands/inbound-event-ref';

const BASE = {
  eventId: '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11',
  orderId: '4889fbea-c49f-4094-8ca9-45d79508477e',
};

describe('describeInboundEvent', () => {
  it('should name the payment id for a payment event', () => {
    const text = describeInboundEvent({
      ...BASE,
      topic: 'payments.payment-processed',
      paymentId: '11111111-1111-4111-8111-111111111111',
    });

    expect(text).toBe(
      `orderId=${BASE.orderId} paymentId=11111111-1111-4111-8111-111111111111 ` +
        `eventId=${BASE.eventId} topic=payments.payment-processed`,
    );
  });

  it('should name the reservation id for a stock event', () => {
    const text = describeInboundEvent({
      ...BASE,
      topic: 'inventory.stock-reserved',
      reservationId: '22222222-2222-4222-8222-222222222222',
    });

    expect(text).toContain('reservationId=22222222-2222-4222-8222-222222222222');
    expect(text).not.toContain('paymentId');
  });
});
