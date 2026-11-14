import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ApplyStockOutcomeCommand } from '../commands/apply-stock-outcome.command';
import { StockOutcome } from '../domain/stock-outcome.enum';
import { OutcomeWriteFlow, OutcomeWriteResult } from './outcome-write-flow';

/**
 * Applies a consumed stock outcome (`inventory.stock-reserved` / `inventory.stock-rejected`)
 * to its order through the shared write flow. Picks the matching Order method for the message
 * type; every business decision is made by the Order aggregate.
 */
@CommandHandler(ApplyStockOutcomeCommand)
export class ApplyStockOutcomeService implements ICommandHandler<
  ApplyStockOutcomeCommand,
  OutcomeWriteResult
> {
  constructor(private readonly writeFlow: OutcomeWriteFlow) {}

  /** Runs the write flow once per `eventId`; see OutcomeWriteFlow.run. */
  execute(command: ApplyStockOutcomeCommand): Promise<OutcomeWriteResult> {
    return this.writeFlow.run(command.inboundEvent, (order) =>
      command.outcome === StockOutcome.RESERVED
        ? order.recordStockReserved()
        : order.recordStockRejected(command.reason),
    );
  }
}
