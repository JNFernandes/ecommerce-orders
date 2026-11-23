import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { AccessTokenClaims } from '../../infra/auth/access-token-claims';
import './request-user';

/**
 * Reads the verified caller for a handler. The only way handlers get user data. Throws a 500 if
 * no caller is attached, which means the auth guard did not run (a wiring bug).
 */
export function currentUserFactory(_data: unknown, context: ExecutionContext): AccessTokenClaims {
  const user =
    context.getType() === 'http' ? context.switchToHttp().getRequest<Request>().user : undefined;
  if (user === undefined) {
    throw new InternalServerErrorException();
  }
  return user;
}

/** Injects the verified {@link AccessTokenClaims} of the caller. */
export const CurrentUser = createParamDecorator(currentUserFactory);
