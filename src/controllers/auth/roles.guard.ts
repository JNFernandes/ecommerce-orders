import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType } from '@nestjs/graphql';
import { forbiddenError } from '../../graphql/graphql-auth.errors';
import { effectiveRoles } from '../../infra/auth/access-token-claims';
import { Role } from '../../infra/auth/role.enum';
import { callerOf } from './caller';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * Global guard that runs after `JwtAuthGuard`: lets a request through when the caller's effective
 * roles (research R10) include one of the route's `@Roles`, else answers 403 on REST and a
 * `FORBIDDEN` error on GraphQL. `@Public` routes and routes without role metadata pass here; the
 * startup route policy check rejects the latter. Other transports pass through.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /** Decides whether the caller may use the handler. */
  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const type = context.getType<GqlContextType>();
    if (required === undefined || (type !== 'http' && type !== 'graphql')) {
      return true;
    }
    const user = callerOf(context);
    const roles = user === undefined ? [] : effectiveRoles(user);
    if (roles.some((role) => required.includes(role))) {
      return true;
    }
    throw type === 'graphql' ? forbiddenError() : new ForbiddenException();
  }
}
