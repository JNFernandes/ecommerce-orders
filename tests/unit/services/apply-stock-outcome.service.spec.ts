import { ApplyStockOutcomeCommand } from '../../../src/commands/apply-stock-outcome.command';
import { InboundEventRef } from '../../../src/commands/inbound-event-ref';
import { Order } from '../../../src/domain/order.aggregate';
import { StockOutcome } from '../../../src/domain/stock-outcome.enum';
import { Attention, OutcomeRecord } from '../../../src/domain/outcome-application';
import { ApplyStockOutcomeService } from '../../../src/services/apply-stock-outcome.service';
import { OutcomeWriteFlow } from '../../../src/services/outcome-write-flow';

const INBOUND: InboundEventRef = {
  eventId: '9b1f0c1e-2d0c-4a52-9a1f-0f6c3f1c2b11',
  topic: 'inventory.stock-reserved',
  orderId: '4889fbea-c49f-4094-8ca9-45d79508477e',
  reservationId: '5d2f6a90-8a7b-4f0b-9a54-2a1f2e7b9c33',
};

function setup(): { service: ApplyStockOutcomeService; run: jest.Mock; order: jest.Mocked<Order> } {
  const order = {
    recordStockReserved: jest
      .fn()
      .mockReturnValue({ record: OutcomeRecord.RECORDED, attention: Attention.NONE }),
    recordStockRejected: jest
      .fn()
      .mockReturnValue({ record: OutcomeRecord.CANCELLED, attention: Attention.NONE }),
  } as unknown as jest.Mocked<Order>;
  const run = jest
    .fn()
    .mockImplementation(
      async (_inbound, apply: (o: Order) => { record: OutcomeRecord }) => apply(order).record,
    );
  const service = new ApplyStockOutcomeService({ run } as unknown as OutcomeWriteFlow);
  return { service, run, order };
}

describe('ApplyStockOutcomeService', () => {
  it('should run the write flow for the inbound event and record a reserved stock on the order', async () => {
    const { service, run, order } = setup();

    const result = await service.execute(
      new ApplyStockOutcomeCommand(StockOutcome.RESERVED, INBOUND),
    );

    expect(result).toBe(OutcomeRecord.RECORDED);
    expect(run).toHaveBeenCalledWith(INBOUND, expect.any(Function));
    expect(order.recordStockReserved).toHaveBeenCalledTimes(1);
    expect(order.recordStockRejected).not.toHaveBeenCalled();
  });

  it('should record a rejected stock with the reason from the message', async () => {
    const { service, order } = setup();

    const result = await service.execute(
      new ApplyStockOutcomeCommand(StockOutcome.REJECTED, INBOUND, 'insufficient stock'),
    );

    expect(result).toBe(OutcomeRecord.CANCELLED);
    expect(order.recordStockRejected).toHaveBeenCalledWith('insufficient stock');
    expect(order.recordStockReserved).not.toHaveBeenCalled();
  });

  it('should pass a missing rejection reason through as undefined (the domain decides the text)', async () => {
    const { service, order } = setup();

    await service.execute(new ApplyStockOutcomeCommand(StockOutcome.REJECTED, INBOUND));

    expect(order.recordStockRejected).toHaveBeenCalledWith(undefined);
  });

  it('should propagate a failure of the write flow so the consumer can retry it', async () => {
    const { service, run } = setup();
    run.mockRejectedValue(new Error('database down'));

    await expect(
      service.execute(new ApplyStockOutcomeCommand(StockOutcome.RESERVED, INBOUND)),
    ).rejects.toThrow('database down');
  });
});
