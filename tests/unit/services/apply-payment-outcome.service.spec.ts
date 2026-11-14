import { ApplyPaymentOutcomeCommand } from '../../../src/commands/apply-payment-outcome.command';
import { InboundEventRef } from '../../../src/commands/inbound-event-ref';
import { Order } from '../../../src/domain/order.aggregate';
import { PaymentOutcome } from '../../../src/domain/payment-outcome.enum';
import { Attention, OutcomeRecord } from '../../../src/domain/outcome-application';
import { ApplyPaymentOutcomeService } from '../../../src/services/apply-payment-outcome.service';
import { OutcomeWriteFlow } from '../../../src/services/outcome-write-flow';

const INBOUND: InboundEventRef = {
  eventId: '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11',
  topic: 'payments.payment-processed',
  orderId: '4889fbea-c49f-4094-8ca9-45d79508477e',
  paymentId: '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33',
};

function setup(): {
  service: ApplyPaymentOutcomeService;
  run: jest.Mock;
  order: jest.Mocked<Order>;
} {
  const order = {
    recordPaymentProcessed: jest
      .fn()
      .mockReturnValue({ record: OutcomeRecord.RECORDED, attention: Attention.NONE }),
    recordPaymentFailed: jest
      .fn()
      .mockReturnValue({ record: OutcomeRecord.CANCELLED, attention: Attention.NONE }),
  } as unknown as jest.Mocked<Order>;
  const run = jest
    .fn()
    .mockImplementation(
      async (_inbound, apply: (o: Order) => { record: OutcomeRecord }) => apply(order).record,
    );
  const service = new ApplyPaymentOutcomeService({ run } as unknown as OutcomeWriteFlow);
  return { service, run, order };
}

describe('ApplyPaymentOutcomeService', () => {
  it('should run the write flow for the inbound event and record a processed payment on the order', async () => {
    const { service, run, order } = setup();

    const result = await service.execute(
      new ApplyPaymentOutcomeCommand(PaymentOutcome.PROCESSED, INBOUND),
    );

    expect(result).toBe(OutcomeRecord.RECORDED);
    expect(run).toHaveBeenCalledWith(INBOUND, expect.any(Function));
    expect(order.recordPaymentProcessed).toHaveBeenCalledTimes(1);
    expect(order.recordPaymentFailed).not.toHaveBeenCalled();
  });

  it('should record a failed payment with the reason from the message', async () => {
    const { service, order } = setup();

    const result = await service.execute(
      new ApplyPaymentOutcomeCommand(PaymentOutcome.FAILED, INBOUND, 'card declined'),
    );

    expect(result).toBe(OutcomeRecord.CANCELLED);
    expect(order.recordPaymentFailed).toHaveBeenCalledWith('card declined');
    expect(order.recordPaymentProcessed).not.toHaveBeenCalled();
  });

  it('should pass a missing failure reason through as undefined (the domain decides the text)', async () => {
    const { service, order } = setup();

    await service.execute(new ApplyPaymentOutcomeCommand(PaymentOutcome.FAILED, INBOUND));

    expect(order.recordPaymentFailed).toHaveBeenCalledWith(undefined);
  });

  it('should propagate a failure of the write flow so the consumer can retry it', async () => {
    const { service, run } = setup();
    run.mockRejectedValue(new Error('database down'));

    await expect(
      service.execute(new ApplyPaymentOutcomeCommand(PaymentOutcome.PROCESSED, INBOUND)),
    ).rejects.toThrow('database down');
  });
});
