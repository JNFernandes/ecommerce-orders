import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { KafkaConfig } from '../../config/configuration';
import { KAFKA_CLIENT, KAFKA_PRODUCER } from './kafka.constants';
import { createKafkaLogCreator } from './kafka-log-creator';

/** Shared by both clients, so a broker outage is throttled once, not per client. */
const kafkaLogCreator = createKafkaLogCreator();

/**
 * Kafka client and producer wiring. Nothing here connects: the producer connects lazily on its
 * first publish (OrderEventsProducer, which also disconnects it on shutdown) and the consumers
 * connect in the background, so the service starts even when Kafka is down.
 *
 * The producer gets **its own client** with `retry.retries = KAFKA_PRODUCER_RETRIES`. kafkajs
 * uses the client-level retry for broker connections, so this, with `connectionTimeout`, bounds
 * how long a publish to an unreachable broker takes (about 3 s with the defaults). The consumers'
 * client (`KAFKA_CLIENT`) keeps kafkajs's default retries: lowering them made consumers give up
 * on routine startup errors such as "group coordinator not available".
 *
 * Both clients log through the Nest logger (`createKafkaLogCreator`), which throttles kafkajs's
 * per-retry connection-failure lines during an outage.
 */
@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: (configService: ConfigService): Kafka => {
        const config = configService.getOrThrow<KafkaConfig>('kafka');
        return new Kafka({
          clientId: config.clientId,
          brokers: config.brokers,
          connectionTimeout: config.connectionTimeoutMs,
          logCreator: kafkaLogCreator,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: KAFKA_PRODUCER,
      useFactory: (configService: ConfigService): Producer => {
        const config = configService.getOrThrow<KafkaConfig>('kafka');
        const retry = { retries: config.producerRetries };
        return new Kafka({
          clientId: config.clientId,
          brokers: config.brokers,
          connectionTimeout: config.connectionTimeoutMs,
          retry,
          logCreator: kafkaLogCreator,
        }).producer({ retry });
      },
      inject: [ConfigService],
    },
  ],
  exports: [KAFKA_CLIENT, KAFKA_PRODUCER],
})
export class KafkaModule {}
