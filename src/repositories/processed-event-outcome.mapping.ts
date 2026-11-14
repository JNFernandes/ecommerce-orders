import { OutcomeRecord } from '../domain/outcome-application';
import { ProcessedEventOutcome } from '../infra/database/entities/processed-event.entity';

/**
 * Persistence mapping from the domain's OutcomeRecord to the stored processed-event outcome.
 * One to one by name; the `Record` type makes the compiler reject a missing value.
 */
const TO_PROCESSED_EVENT_OUTCOME: Record<OutcomeRecord, ProcessedEventOutcome> = {
  [OutcomeRecord.RECORDED]: ProcessedEventOutcome.RECORDED,
  [OutcomeRecord.CONFIRMED]: ProcessedEventOutcome.CONFIRMED,
  [OutcomeRecord.CANCELLED]: ProcessedEventOutcome.CANCELLED,
  [OutcomeRecord.IGNORED_DUPLICATE]: ProcessedEventOutcome.IGNORED_DUPLICATE,
  [OutcomeRecord.IGNORED_ALREADY_CONFIRMED]: ProcessedEventOutcome.IGNORED_ALREADY_CONFIRMED,
  [OutcomeRecord.IGNORED_ALREADY_CANCELLED]: ProcessedEventOutcome.IGNORED_ALREADY_CANCELLED,
  [OutcomeRecord.IGNORED_CONFLICT]: ProcessedEventOutcome.IGNORED_CONFLICT,
};

/** The processed-event outcome stored for a domain OutcomeRecord. */
export function toProcessedEventOutcome(record: OutcomeRecord): ProcessedEventOutcome {
  return TO_PROCESSED_EVENT_OUTCOME[record];
}
