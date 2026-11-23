/** Roles Orders understands in an Identity access token. */
export enum Role {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
}

const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(Object.values(Role));

/** Type guard: whether a role string is one Orders understands. */
function isRole(value: string): value is Role {
  return KNOWN_ROLES.has(value);
}

/**
 * Keeps the roles Orders understands, in order and without duplicates, and drops any other
 * string (a token may carry roles meant for other services).
 */
export function parseRoles(values: readonly string[]): readonly Role[] {
  return [...new Set(values.filter(isRole))];
}
