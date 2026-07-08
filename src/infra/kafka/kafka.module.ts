import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { KafkaConfig } from '../../config/configuration';
import { KAFKA_CLIENT, KAFKA_PRODUCER } from './kafka.constants';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: (configService: ConfigService): Kafka => {
        const kafkaConfig = configService.get<KafkaConfig>('kafka');
        return new Kafka({
          clientId: kafkaConfig?.clientId ?? 'ecommerce-orders',
          brokers: kafkaConfig?.brokers ?? ['localhost:9092'],
        });
      },
      inject: [ConfigService],
    },
    {
      provide: KAFKA_PRODUCER,
      useFactory: async (kafka: Kafka): Promise<Producer> => {
        const producer = kafka.producer();
        await producer.connect();
        return producer;
      },
      inject: [KAFKA_CLIENT],
    },
  ],
  exports: [KAFKA_CLIENT, KAFKA_PRODUCER],
})
export class KafkaModule implements OnModuleDestroy {
  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }
}
