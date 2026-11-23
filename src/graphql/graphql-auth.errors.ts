import { GraphQLError } from 'graphql';
import { AccessTokenError } from '../infra/auth/access-token.error';

/** Message of every `UNAUTHENTICATED` error (contracts/graphql-auth.md). */
export const UNAUTHENTICATED_MESSAGE = 'Unauthorized';

/** Message of the `SERVICE_UNAVAILABLE` error when Identity's keys cannot be loaded. */
export const AUTH_UNAVAILABLE_MESSAGE = 'Authentication is temporarily unavailable, please retry';

/** Message of every `FORBIDDEN` error. */
export const FORBIDDEN_MESSAGE = 'Forbidden';

/**
 * Keeps the GraphQL convention of HTTP 200 for these errors. Apollo answers an error thrown
 * before execution with 500 unless the error sets `extensions.http`, which Apollo strips from
 * the response.
 */
const HTTP_OK = { status: 200 };

/**
 * The GraphQL error for a request without a verified caller: `SERVICE_UNAVAILABLE` when no
 * Identity keys could be loaded, `UNAUTHENTICATED` otherwise (also when `error` is `null`). The
 * message is fixed, so it never says why a token was rejected or contains any part of it.
 */
export function authenticationError(error: AccessTokenError | null): GraphQLError {
  if (error?.kind === 'KEYS_UNAVAILABLE') {
    return new GraphQLError(AUTH_UNAVAILABLE_MESSAGE, {
      extensions: { code: 'SERVICE_UNAVAILABLE', http: HTTP_OK },
    });
  }
  return new GraphQLError(UNAUTHENTICATED_MESSAGE, {
    extensions: { code: 'UNAUTHENTICATED', http: HTTP_OK },
  });
}

/** The GraphQL error for a verified caller without a role the resolver accepts. */
export function forbiddenError(): GraphQLError {
  return new GraphQLError(FORBIDDEN_MESSAGE, { extensions: { code: 'FORBIDDEN' } });
}
