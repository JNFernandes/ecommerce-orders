import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';
import { GraphqlContext } from '../../graphql/graphql-context';
import { AccessTokenClaims } from '../../infra/auth/access-token-claims';
import './request-user';

/**
 * The verified caller of a REST or GraphQL request (set by `JwtAuthGuard` on REST, by the
 * GraphQL context on GraphQL), or `undefined` when there is none or the transport is neither.
 */
export function callerOf(context: ExecutionContext): AccessTokenClaims | undefined {
  const type = context.getType<GqlContextType>();
  if (type === 'http') {
    return context.switchToHttp().getRequest<Request>().user;
  }
  if (type === 'graphql') {
    return GqlExecutionContext.create(context).getContext<GraphqlContext>().user ?? undefined;
  }
  return undefined;
}
