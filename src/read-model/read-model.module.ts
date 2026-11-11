import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ReadModelConfig } from '../config/configuration';
import { OrderViewDocument, OrderViewSchema } from './order-view.schema';
import { ReadModelConnectionMonitor, observeReadModelConnection } from './read-model-connection';
import { OrderViewRepository } from './order-view.repository';
import { OrderProjectionService } from './order-projection.service';

/**
 * The CQRS read side (ADR 0001): the MongoDB `order_views` read model and the projection that
 * keeps it up to date from order events (OrderProjectionService → projectOrderEvent →
 * OrderViewRepository). The Kafka adapter feeding it (OrderProjectionConsumer) is registered in
 * AppModule with the other consumers, so nothing in src/read-model depends on Kafka or on the
 * write model. Connects lazily so a MongoDB outage never blocks startup of the HTTP API or the
 * payment consumer.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const readModel = configService.get<ReadModelConfig>('readModel');
        return {
          uri: readModel?.mongoUri,
          lazyConnection: true,
          bufferCommands: false,
          // Indexes are created explicitly on connect (ReadModelConnectionMonitor), not at model
          // compile time, which would race the lazy connection.
          autoIndex: false,
          serverSelectionTimeoutMS: 5000,
          connectionFactory: observeReadModelConnection,
        };
      },
    }),
    MongooseModule.forFeature([{ name: OrderViewDocument.name, schema: OrderViewSchema }]),
  ],
  providers: [ReadModelConnectionMonitor, OrderViewRepository, OrderProjectionService],
  exports: [OrderViewRepository, OrderProjectionService],
})
export class ReadModelModule {}
