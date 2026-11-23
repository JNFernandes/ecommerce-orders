import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { authenticationError } from '../../graphql/graphql-auth.errors';
import { GraphqlContext } from '../../graphql/graphql-context';
import { AccessTokenError } from '../../infra/auth/access-token.error';
import { AccessTokenVerifier } from '../../infra/auth/access-token.verifier';
import { extractBearerToken } from './bearer-token';
import { IS_PUBLIC_KEY } from './public.decorator';
import './request-user';

/**
 * Global guard that runs first: skips `@Public` handlers, otherwise requires a verified caller.
 * REST: requires a valid `Authorization: Bearer` token and attaches its claims to the request;
 * failures are thrown as {@link AccessTokenError} and answered by `AuthExceptionFilter` (401 /
 * 503). GraphQL: the token was already verified in the context (research R11), so it only checks
 * that the context holds a caller, else throws the `UNAUTHENTICATED` / `SERVICE_UNAVAILABLE`
 * GraphQL error. Other transports pass through.
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
    if (isPublic) {
      return true;
    }
    if (context.getType<GqlContextType>() === 'graphql') {
      const graphql = GqlExecutionContext.create(context).getContext<GraphqlContext>();
      if (graphql.user === null) {
        throw authenticationError(graphql.authError);
      }
      return true;
    }
    if (context.getType() !== 'http') {
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
