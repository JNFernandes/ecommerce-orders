import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CorsConfig } from './config/configuration';
import { buildCorsOptions } from './app.cors';

/**
 * Application-wide setup shared by `main.ts` and the tests, so tests validate input exactly as
 * production does. The global ValidationPipe applies to REST DTOs and GraphQL `@Args()` classes.
 *
 * CORS is enabled for the REST API and /graphql (one Express middleware in front of both) only
 * when `CORS_ALLOWED_ORIGINS` lists at least one origin; see {@link buildCorsOptions}. Requires
 * the `ConfigModule` to be loaded.
 */
export function configureApp(app: INestApplication): void {
  const allowedOrigins = app.get(ConfigService).get<CorsConfig>('cors')?.allowedOrigins ?? [];
  const corsOptions = buildCorsOptions(allowedOrigins);
  if (corsOptions !== null) {
    app.enableCors(corsOptions);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
}
