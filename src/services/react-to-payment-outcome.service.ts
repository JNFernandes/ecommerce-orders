import { Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ReactToPaymentOutcomeCommand } from '../commands/react-to-payment-outcome.command';
import { ConfirmOrderCommand } from '../commands/confirm-order.command';
import { CancelOrderCommand } from '../commands/cancel-order.command';
import { InboundEventRef } from '../commands/inbound-event-ref';
import { PaymentReaction, decidePaymentReaction } from '../domain/payment-reaction.policy';
import { ProcessedEventOutcome } from '../infra/database/entities/processed-event.entity';
import { OrderRepository } from '../repositories/order.repository';
import { ProcessedEventRepository } from '../repositories/processed-event.repository';
import {
  EventAlreadyProcessedError,
  OrderNotFoundForPaymentError,
} from './errors/payment-outcome.errors';

/** Result when the event's `eventId` had already been processed (nothing was done). */
export const ALREADY_PROCESSED = 'ALREADY_PROCESSED';

/** What happened to a consumed payment event. */
export type ReactToPaymentOutcomeResult = ProcessedEventOutcome | typeof ALREADY_PROCESSED;

/**
 * Orchestrates the reaction to a payment outcome consumed from Kafka: loads the order named by
 * the event's `orderId` (never its `aggregateId`, the payment id), asks the domain policy what
 * to do, then either dispatches the existing Confirm/Cancel command (which saves the change and
 * the processed-event record atomically, then publishes) or records a no-op. Holds no business
 * rules of its own.
 */
@CommandHandler(ReactToPaymentOutcomeCommand)
export class ReactToPaymentOutcomeService implements ICommandHandler<
  ReactToPaymentOutcomeCommand,
  ReactToPaymentOutcomeResult
> {
  private readonly logger = new Logger(ReactToPaymentOutcomeService.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly orderRepository: OrderRepository,
    private readonly processedEventRepository: ProcessedEventRepository,
  ) {}

  /**
   * Reacts to the payment outcome exactly once per `eventId`: a redelivered event (already in
   * `processed_events`, or recorded concurrently) returns ALREADY_PROCESSED with no effect.
   */
  async execute(command: ReactToPaymentOutcomeCommand): Promise<ReactToPaymentOutcomeResult> {
    const { inboundEvent } = command;

    if (await this.processedEventRepository.exists(inboundEvent.eventId)) {
      this.logger.debug(`skipping already processed event; ${describe(inboundEvent)}`);
      return ALREADY_PROCESSED;
    }

    try {
      return await this.react(command);
    } catch (error) {
      if (error instanceof EventAlreadyProcessedError) {
        this.logger.debug(`event recorded concurrently, skipping; ${describe(inboundEvent)}`);
        return ALREADY_PROCESSED;
      }
      throw error;
    }
  }

  private async react(command: ReactToPaymentOutcomeCommand): Promise<ReactToPaymentOutcomeResult> {
    const { inboundEvent } = command;

    const order = await this.orderRepository.findById(inboundEvent.orderId);
    if (!order) {
      throw new OrderNotFoundForPaymentError(inboundEvent.orderId, inboundEvent.paymentId);
    }

    const reaction = decidePaymentReaction(order.status, command.outcome);
    switch (reaction) {
      case PaymentReaction.CONFIRM:
        await this.commandBus.execute(new ConfirmOrderCommand(order.id, inboundEvent));
        return ProcessedEventOutcome.CONFIRMED;

      case PaymentReaction.ALREADY_CONFIRMED:
        this.logger.debug(`order ${order.id} already CONFIRMED; ${describe(inboundEvent)}`);
        return this.recordNoOp(inboundEvent, ProcessedEventOutcome.IGNORED_ALREADY_CONFIRMED);

      case PaymentReaction.CANCEL:
        await this.commandBus.execute(
          new CancelOrderCommand(order.id, { reason: command.reason ?? '', inboundEvent }),
        );
        return ProcessedEventOutcome.CANCELLED;

      case PaymentReaction.ALREADY_CANCELLED:
        this.logger.debug(`order ${order.id} already CANCELLED; ${describe(inboundEvent)}`);
        return this.recordNoOp(inboundEvent, ProcessedEventOutcome.IGNORED_ALREADY_CANCELLED);

      case PaymentReaction.CONFLICT:
        this.logger.warn(
          `ignoring ${command.outcome} payment for order ${order.id} in status ${order.status}; ` +
            describe(inboundEvent),
        );
        return this.recordNoOp(inboundEvent, ProcessedEventOutcome.IGNORED_CONFLICT);
    }
  }

  private async recordNoOp(
    inboundEvent: InboundEventRef,
    outcome: ProcessedEventOutcome,
  ): Promise<ReactToPaymentOutcomeResult> {
    await this.processedEventRepository.recordOutcome(inboundEvent, outcome);
    return outcome;
  }
}

function describe(ref: InboundEventRef): string {
  return `orderId=${ref.orderId} paymentId=${ref.paymentId} eventId=${ref.eventId} topic=${ref.topic}`;
}
