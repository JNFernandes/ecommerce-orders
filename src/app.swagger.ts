import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Builds the OpenAPI document for the REST API, with the `bearer` (JWT) scheme every protected
 * operation references (US-11). Shared by `main.ts` and the tests.
 */
export function buildSwaggerDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ecommerce-orders')
    .setDescription('Orders microservice — write path (REST) for placing orders')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from ecommerce-identity (`POST /auth/login`)',
      },
      'bearer',
    )
    .build();
  return SwaggerModule.createDocument(app, config);
}

/**
 * Serves Swagger UI at `/api` and the document at `/api-json`. These are not Nest routes, so they
 * stay public without `@Public()`.
 */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('api', app, buildSwaggerDocument(app));
}
