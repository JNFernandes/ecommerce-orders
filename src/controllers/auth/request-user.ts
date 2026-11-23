import { AccessTokenClaims } from '../../infra/auth/access-token-claims';

/**
 * Adds the verified caller to Express requests. Set only by `JwtAuthGuard`; read only through
 * `@CurrentUser()`.
 */
declare module 'express-serve-static-core' {
  interface Request {
    user?: AccessTokenClaims;
  }
}

export {};
