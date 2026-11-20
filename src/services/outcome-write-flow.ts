import { Injectable, Logger } from '@nestjs/common';
import { InboundEventRef, describeInboundEvent } from '../commands/inbound-event-ref';
import { Order } from '../domain/order.aggregate';
import { Attention, OutcomeApplication, OutcomeRecord } from '../domain/outcome-application';
import { OrderCancelled } from '../domain/events/order-cancelled.event';
import { OrderConfirmed } from '../domain/events/order-confirmed.event';
import {
  ORDER_CANCELLED_TOPIC,
  ORDER_CONFIRMED_TOPIC,
  OrderEventsProducer,
} from '../infra/kafka/order-events.producer';
import { OrderRepository } from '../repositories/order.repository';
import { OrderDeadLetterRepository } from '../repositories/order-dead-letter.repository';
import { ProcessedEventRepository } from '../repositories/processed-event.repository';
import { EventAlreadyProcessedError, OrderNotFoundForOutcomeError } from './errors/outcome.errors';

/** Result when the event's `eventId` had already been processed (nothing was done). */
export const ALREADY_PROCESSED = 'ALREADY_PROCESSED';

/** What happened to a consumed payment or stock event. */
export type OutcomeWriteResult = OutcomeRecord | typeof ALREADY_PROCESSED;

const IGNORED_RECORDS: ReadonlySet<OutcomeRecord> = new Set([
  OutcomeRecord.IGNORED_DUPLICATE,
  OutcomeRecord.IGNORED_ALREADY_CONFIRMED,
  OutcomeRecord.IGNORED_ALREADY_CANCELLED,
  OutcomeRecord.IGNORED_CONFLICT,
]);

/**
 * The write flow shared by the payment and stock outcome handlers. It orchestrates only:
 * dedupe by `eventId` → load the order named by `orderId` (never the event's `aggregateId`) →
 * let the Order aggregate apply the outcome → save (state change and processed-event record
 * in one guarded transaction) → only then publish the raised event, dead-lettering a failed
 * publish. Every decision, including how an ignored outcome is classified, is the domain's;
 * this class copies the domain's `record` and picks the log level from its `attention`.
 */
@Injectable()
export class OutcomeWriteFlow {
  private readonly logger = new Logger(OutcomeWriteFlow.name);

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly processedEventRepository: ProcessedEventRepository,
    private readonly orderEventsProducer: OrderEventsProducer,
    private readonly orderDeadLetterRepository: OrderDeadLetterRepository,
  ) {}

  /**
   * Applies one consumed outcome exactly once per `eventId`.
   *
   * @param inbound The consumed event; its `orderId` names the order.
   * @param apply Calls the matching `Order.record*()` method.
   * @returns The domain's record, or ALREADY_PROCESSED for a redelivered event.
   * @throws OrderNotFoundForOutcomeError if no order has the event's `orderId` (retryable).
   * @throws OrderStatusChangedConcurrentlyError if the order changed since it was loaded
   *   (retryable: the retry reloads the order).
   */
  async run(
    inbound: InboundEventRef,
    apply: (order: Order) => OutcomeApplication,
  ): Promise<OutcomeWriteResult> {
    if (await this.processedEventRepository.exists(inbound.eventId)) {
      this.logger.debug(`skipping already processed event; ${describeInboundEvent(inbound)}`);
      return ALREADY_PROCESSED;
    }

    try {
      return await this.applyOnce(inbound, apply);
    } catch (error) {
      if (error instanceof EventAlreadyProcessedError) {
        this.logger.debug(
          `event recorded concurrently, skipping; ${describeInboundEvent(inbound)}`,
        );
        return ALREADY_PROCESSED;
      }
      throw error;
    }
  }

  private async applyOnce(
    inbound: InboundEventRef,
    apply: (order: Order) => OutcomeApplication,
  ): Promise<OutcomeRecord> {
    const orderId = inbound.orderId;
    if (orderId === undefined) {
      throw new Error(`outcome event has no orderId; ${describeInboundEvent(inbound)}`);
    }
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderNotFoundForOutcomeError(
        orderId,
        inbound.topic,
        inbound.paymentId ?? inbound.reservationId,
      );
    }

    const loaded = { paymentOutcome: order.paymentOutcome, stockOutcome: order.stockOutcome };
    const { record, attention } = apply(order);

    if (IGNORED_RECORDS.has(record)) {
      this.logIgnored(order, record, attention, inbound);
      await this.processedEventRepository.recordIgnoredOutcome(inbound, record);
      return record;
    }

    const events = order.pullDomainEvents();
    await this.orderRepository.applyOutcome(order, loaded, inbound, record);
    for (const event of events) {
      await this.publish(event, order.id);
    }
    return record;
  }

  private logIgnored(
    order: Order,
    record: OutcomeRecord,
    attention: Attention,
    inbound: InboundEventRef,
  ): void {
    const details =
      `order ${order.id} is ${order.status} (payment ${order.paymentOutcome}, ` +
      `stock ${order.stockOutcome}); ignored as ${record}; ${describeInboundEvent(inbound)}`;
    switch (attention) {
      case Attention.REFUND_NEEDED:
        this.logger.warn(`payment needs refund: ${details}`);
        return;
      case Attention.CONFLICT:
        this.logger.warn(`conflicting outcome: ${details}`);
        return;
      case Attention.NONE:
        this.logger.log(`ignoring outcome: ${details}`);
        return;
    }
  }

  private async publish(event: unknown, orderId: string): Promise<void> {
    if (event instanceof OrderConfirmed) {
      await this.publishOrDeadLetter(ORDER_CONFIRMED_TOPIC, event, orderId, () =>
        this.orderEventsProducer.publishOrderConfirmed(event),
      );
    } else if (event instanceof OrderCancelled) {
      await this.publishOrDeadLetter(ORDER_CANCELLED_TOPIC, event, orderId, () =>
        this.orderEventsProducer.publishOrderCancelled(event),
      );
    }
  }

  private async publishOrDeadLetter(
    topic: string,
    event: OrderConfirmed | OrderCancelled,
    orderId: string,
    publish: () => Promise<void>,
  ): Promise<void> {
    try {
      await publish();
    } catch (error) {
      this.logger.error(
        `Failed to publish ${topic} for order ${orderId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.orderDeadLetterRepository.recordFailure(topic, event, error as Error);
    }
  }
}
