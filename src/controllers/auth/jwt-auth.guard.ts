import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AccessTokenError } from '../../infra/auth/access-token.error';
import { AccessTokenVerifier } from '../../infra/auth/access-token.verifier';
import { extractBearerToken } from './bearer-token';
import { IS_PUBLIC_KEY } from './public.decorator';
import './request-user';

/**
 * Global guard that runs first: skips `@Public` handlers, otherwise requires a valid
 * `Authorization: Bearer` token and attaches its claims to the request. Failures are thrown as
 * {@link AccessTokenError} and answered by `AuthExceptionFilter` (401 / 503).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  /** Verifies the caller's token, or lets a public handler through. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic || context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      throw new AccessTokenError('INVALID', 'missing');
    }
    request.user = await this.verifier.verify(token);
    return true;
  }
}
