import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { AccessTokenClaims } from '../../infra/auth/access-token-claims';
import { callerOf } from './caller';

/**
 * Reads the verified caller for a REST handler or a GraphQL resolver. The only way handlers get
 * user data. Throws a 500 if no caller is attached, which means the auth guard did not run (a
 * wiring bug).
 */
export function currentUserFactory(_data: unknown, context: ExecutionContext): AccessTokenClaims {
  const user = callerOf(context);
  if (user === undefined) {
    throw new InternalServerErrorException();
  }
  return user;
}

/** Injects the verified {@link AccessTokenClaims} of the caller. */
export const CurrentUser = createParamDecorator(currentUserFactory);
