import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { setupSwagger } from './app.swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);
  // Run onModuleDestroy / onApplicationShutdown on SIGTERM/SIGINT so the Kafka consumers and the
  // dead-letter retry worker stop cleanly in production (tests close their apps explicitly).
  app.enableShutdownHooks();

  setupSwagger(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3000;
  await app.listen(port);
}

bootstrap();
