import { Admin } from 'kafkajs';

type CreateTopicsOptions = Parameters<Admin['createTopics']>[0];

/**
 * `admin.createTopics`, retried until the Kafka test container is ready.
 *
 * A freshly started KafkaContainer accepts connections before its controller has been elected;
 * under load (several containers starting in parallel during a full test run) `createTopics` then
 * fails with `KafkaJSBrokerNotFound: Broker -1 not found in the cached metadata`. That was the
 * cause of the intermittent "whole component suite fails" runs. Retrying until the controller
 * answers (or the timeout expires) makes topic setup deterministic. Re-running is safe: topics
 * that already exist are skipped by Kafka.
 */
export async function createTopicsWhenReady(
  admin: Admin,
  options: CreateTopicsOptions,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await admin.createTopics(options);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
