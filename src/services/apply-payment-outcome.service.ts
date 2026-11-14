import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ApplyPaymentOutcomeCommand } from '../commands/apply-payment-outcome.command';
import { PaymentOutcome } from '../domain/payment-outcome.enum';
import { OutcomeWriteFlow, OutcomeWriteResult } from './outcome-write-flow';

/**
 * Applies a consumed payment outcome (`payments.payment-processed` /
 * `payments.payment-failed`) to its order through the shared write flow. Picks the matching
 * Order method for the message type; every business decision is made by the Order aggregate.
 */
@CommandHandler(ApplyPaymentOutcomeCommand)
export class ApplyPaymentOutcomeService implements ICommandHandler<
  ApplyPaymentOutcomeCommand,
  OutcomeWriteResult
> {
  constructor(private readonly writeFlow: OutcomeWriteFlow) {}

  /** Runs the write flow once per `eventId`; see OutcomeWriteFlow.run. */
  execute(command: ApplyPaymentOutcomeCommand): Promise<OutcomeWriteResult> {
    return this.writeFlow.run(command.inboundEvent, (order) =>
      command.outcome === PaymentOutcome.PROCESSED
        ? order.recordPaymentProcessed()
        : order.recordPaymentFailed(command.reason),
    );
  }
}
