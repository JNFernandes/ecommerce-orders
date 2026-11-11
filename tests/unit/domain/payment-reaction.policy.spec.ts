import { OrderStatus } from '../../../src/domain/order-status.enum';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import {
  PaymentReaction,
  decidePaymentReaction,
} from '../../../src/domain/payment-reaction.policy';

describe('decidePaymentReaction', () => {
  it('should return CONFIRM for a PENDING order when payment is PROCESSED', () => {
    expect(decidePaymentReaction(OrderStatus.PENDING, PaymentOutcome.PROCESSED)).toBe(
      PaymentReaction.CONFIRM,
    );
  });

  it('should return CANCEL for a PENDING order when payment is FAILED', () => {
    expect(decidePaymentReaction(OrderStatus.PENDING, PaymentOutcome.FAILED)).toBe(
      PaymentReaction.CANCEL,
    );
  });

  it('should return ALREADY_CONFIRMED for a CONFIRMED order when payment is PROCESSED', () => {
    expect(decidePaymentReaction(OrderStatus.CONFIRMED, PaymentOutcome.PROCESSED)).toBe(
      PaymentReaction.ALREADY_CONFIRMED,
    );
  });

  it('should return CONFLICT for a CONFIRMED order when payment is FAILED', () => {
    expect(decidePaymentReaction(OrderStatus.CONFIRMED, PaymentOutcome.FAILED)).toBe(
      PaymentReaction.CONFLICT,
    );
  });

  it('should return CONFLICT for a CANCELLED order when payment is PROCESSED', () => {
    expect(decidePaymentReaction(OrderStatus.CANCELLED, PaymentOutcome.PROCESSED)).toBe(
      PaymentReaction.CONFLICT,
    );
  });

  it('should return ALREADY_CANCELLED for a CANCELLED order when payment is FAILED', () => {
    expect(decidePaymentReaction(OrderStatus.CANCELLED, PaymentOutcome.FAILED)).toBe(
      PaymentReaction.ALREADY_CANCELLED,
    );
  });
});
