import { CustomDecorator, SetMetadata } from '@nestjs/common';

/** Metadata key set by {@link Public}. */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a handler (or a whole controller) as reachable without an access token. Every route must
 * carry either this or `@Roles`, or the application refuses to start.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
