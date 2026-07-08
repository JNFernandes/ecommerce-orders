import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration, { DatabaseConfig } from './config/configuration';
import { KafkaModule } from './infra/kafka/kafka.module';
import { OrderEventsProducer } from './infra/kafka/order-events.producer';
import { OrderEntity } from './infra/database/entities/order.entity';
import { OrderItemEntity } from './infra/database/entities/order-item.entity';
import { OrderDeadLetterEntity } from './infra/database/entities/order-dead-letter.entity';
import { CustomerEntity } from './infra/database/entities/customer.entity';
import { OrderRepository } from './repositories/order.repository';
import { OrderDeadLetterRepository } from './repositories/order-dead-letter.repository';
import { CustomerRepository } from './repositories/customer.repository';
import { PlaceOrderService } from './services/place-order.service';
import { OrdersController } from './controllers/orders.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get<DatabaseConfig>('database');
        return {
          type: 'postgres' as const,
          host: dbConfig?.host,
          port: dbConfig?.port,
          username: dbConfig?.username,
          password: dbConfig?.password,
          database: dbConfig?.database,
          autoLoadEntities: true,
          synchronize: false,
        };
      },
    }),
    TypeOrmModule.forFeature([OrderEntity, OrderItemEntity, OrderDeadLetterEntity, CustomerEntity]),
    CqrsModule.forRoot(),
    KafkaModule,
  ],
  controllers: [OrdersController],
  providers: [
    PlaceOrderService,
    OrderRepository,
    OrderDeadLetterRepository,
    CustomerRepository,
    OrderEventsProducer,
  ],
})
export class AppModule {}
