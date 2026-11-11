import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ReadModelConfig } from '../config/configuration';
import { OrderViewDocument, OrderViewSchema } from './order-view.schema';
import { ReadModelConnectionMonitor, observeReadModelConnection } from './read-model-connection';

/**
 * The CQRS read side (ADR 0001): the MongoDB `order_views` read model and the projection that
 * keeps it up to date from order events. Connects lazily so a MongoDB outage never blocks
 * startup of the HTTP API or the payment consumer.
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
          serverSelectionTimeoutMS: 5000,
          connectionFactory: observeReadModelConnection,
        };
      },
    }),
    MongooseModule.forFeature([{ name: OrderViewDocument.name, schema: OrderViewSchema }]),
  ],
  providers: [ReadModelConnectionMonitor],
  exports: [],
})
export class ReadModelModule {}
