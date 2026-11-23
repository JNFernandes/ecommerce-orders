import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { Role } from '../../infra/auth/role.enum';

/** Metadata key set by {@link Roles}. */
export const ROLES_KEY = 'auth:roles';

/**
 * Allows a handler (or every handler of a class) to callers holding at least one of these
 * effective roles. Needs at least one role; a method-level `@Roles` overrides the class-level one.
 */
export const Roles = (...roles: [Role, ...Role[]]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);
