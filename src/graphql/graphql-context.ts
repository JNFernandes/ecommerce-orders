import { Request } from 'express';
import { extractBearerToken } from '../controllers/auth/bearer-token';
import { AccessTokenClaims } from '../infra/auth/access-token-claims';
import { AccessTokenError } from '../infra/auth/access-token.error';
import { AccessTokenVerifier } from '../infra/auth/access-token.verifier';

/**
 * Per-request GraphQL context (research R11). The token is verified once, when the context is
 * built: `user` holds the verified caller, or `null` with the reason in `authError`. The auth
 * plugin rejects the operation when `user` is `null`; guards and `@CurrentUser()` read `user`.
 */
export interface GraphqlContext {
  /** The underlying Express request. */
  readonly req: Request;
  /** The verified caller, or `null` when the request has no valid token. */
  readonly user: AccessTokenClaims | null;
  /** Why `user` is `null`; `null` when the caller is verified. */
  readonly authError: AccessTokenError | null;
}

/** The arguments Apollo's Express integration passes to the context function. */
export interface GraphqlContextArgs {
  readonly req: Request;
}

/** Builds the {@link GraphqlContext} of one request. */
export type GraphqlContextFactory = (args: GraphqlContextArgs) => Promise<GraphqlContext>;

/**
 * Returns the context function for Apollo: reads `Authorization: Bearer`, verifies the token and
 * stores the outcome. A rejected token is not thrown (the plugin answers it as a GraphQL error);
 * any other error is rethrown. Never logs or stores the token itself.
 */
export function buildGraphqlContext(
  verifier: Pick<AccessTokenVerifier, 'verify'>,
): GraphqlContextFactory {
  return async ({ req }) => {
    const token = extractBearerToken(req.headers.authorization);
    if (token === null) {
      return { req, user: null, authError: new AccessTokenError('INVALID', 'missing') };
    }
    try {
      return { req, user: await verifier.verify(token), authError: null };
    } catch (error) {
      if (error instanceof AccessTokenError) {
        return { req, user: null, authError: error };
      }
      throw error;
    }
  };
}
