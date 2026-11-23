import { Logger } from '@nestjs/common';
import { authenticationError } from './graphql-auth.errors';
import { GraphqlContext } from './graphql-context';

const logger = new Logger('GraphqlAuthPlugin');

/** The part of Apollo's request context the plugin reads. */
export interface AuthRequestContext {
  readonly contextValue: GraphqlContext;
}

/** The request listener the plugin returns: only `didResolveOperation`. */
export interface AuthRequestListener {
  didResolveOperation(requestContext: AuthRequestContext): Promise<void>;
}

/**
 * Apollo plugin (shape of `ApolloServerPlugin<GraphqlContext>`) that rejects every operation of
 * a caller without a verified token, introspection included, before any resolver runs (research
 * R11). The answer has no `data` and one error: `UNAUTHENTICATED`, or `SERVICE_UNAVAILABLE` when
 * Identity's keys could not be loaded. Logs the rejection category only, never the token.
 */
export const graphqlAuthPlugin = {
  /** Starts the per-request listener. */
  requestDidStart(): Promise<AuthRequestListener> {
    return Promise.resolve({
      didResolveOperation({ contextValue }: AuthRequestContext): Promise<void> {
        if (contextValue.user !== null) {
          return Promise.resolve();
        }
        logger.warn(`Rejected GraphQL request: ${contextValue.authError?.category ?? 'missing'}`);
        return Promise.reject(authenticationError(contextValue.authError));
      },
    });
  },
};
