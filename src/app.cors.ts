import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Methods a cross-origin caller may use: REST reads/writes and GraphQL over GET/POST. */
export const CORS_ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'OPTIONS'];

/** Request headers a cross-origin caller may send. */
export const CORS_ALLOWED_HEADERS: readonly string[] = ['Content-Type', 'Authorization'];

/**
 * CORS options for the REST API and /graphql, or `null` when no origin is allowed (CORS stays
 * off, as it is without `CORS_ALLOWED_ORIGINS`).
 *
 * Origins are matched exactly. A request from any other origin, or without an `Origin` header,
 * gets no CORS headers at all: the origin callback answers `false`, which makes the `cors`
 * middleware pass the request on untouched (a static origin list would still add
 * `Access-Control-Allow-Methods`/`-Headers` to every preflight). Credentials are not allowed.
 */
export function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions | null {
  if (allowedOrigins.length === 0) {
    return null;
  }
  const allowed = new Set(allowedOrigins);
  return {
    origin: (requestOrigin, callback): void => {
      callback(null, requestOrigin !== undefined && allowed.has(requestOrigin));
    },
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: false,
  };
}
