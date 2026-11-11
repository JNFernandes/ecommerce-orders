import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * Application-wide setup shared by `main.ts` and the tests, so tests validate input exactly as
 * production does. The global ValidationPipe applies to REST DTOs and GraphQL `@Args()` classes.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
}
