import { randomUUID } from 'node:crypto';
import { TestIdentity } from './test-identity';

/** An `Authorization` header object for supertest's `.set()`. */
export type BearerHeader = Record<'Authorization', string>;

/** `{ Authorization: 'Bearer <token>' }`. */
export function bearer(token: string): BearerHeader {
  return { Authorization: `Bearer ${token}` };
}

/** Access to the fake Identity started by {@link withTestIdentity}. */
export interface TestIdentityHandle {
  /** The running fake Identity. */
  readonly identity: TestIdentity;
  /**
   * Header with a token holding both `CUSTOMER` and `ADMIN` (and a random `customerId`), allowed
   * on every REST route. For suites that are not about access rules.
   */
  readonly headers: BearerHeader;
}

/**
 * Starts a {@link TestIdentity} in `beforeAll` and points the auth env vars at it, then stops it
 * in `afterAll`. Call it in a `describe` before the `beforeAll` that compiles the Nest module, so
 * the configuration reads the fake Identity's settings.
 */
export function withTestIdentity(): TestIdentityHandle {
  let identity: TestIdentity | undefined;
  let headers: BearerHeader | undefined;

  beforeAll(async () => {
    identity = await TestIdentity.start();
    identity.applyEnv();
    headers = bearer(await identity.customerAdminToken(randomUUID()));
  });

  afterAll(async () => {
    await identity?.stop();
  });

  return {
    get identity(): TestIdentity {
      if (identity === undefined) {
        throw new Error('withTestIdentity: the fake Identity is not started yet');
      }
      return identity;
    },
    get headers(): BearerHeader {
      if (headers === undefined) {
        throw new Error('withTestIdentity: the fake Identity is not started yet');
      }
      return headers;
    },
  };
}
