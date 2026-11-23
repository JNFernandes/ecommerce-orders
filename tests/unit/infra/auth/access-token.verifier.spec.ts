import { generateKeyPair } from 'jose';
import { AccessTokenError } from '../../../../src/infra/auth/access-token.error';
import { AccessTokenVerifier } from '../../../../src/infra/auth/access-token.verifier';
import { Role } from '../../../../src/infra/auth/role.enum';
import { TestIdentity } from '../../../support/test-identity';

const CUSTOMER_ID = '3f0c8f8e-4c55-4a59-9a0b-0f1b2a3c4d5e';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Runs `verify` and returns the AccessTokenError it throws. */
async function rejection(verifier: AccessTokenVerifier, token: string): Promise<AccessTokenError> {
  try {
    await verifier.verify(token);
  } catch (error) {
    if (error instanceof AccessTokenError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the token to be rejected');
}

/** Asserts an INVALID rejection with this category whose message never leaks the token. */
async function expectInvalid(
  verifier: AccessTokenVerifier,
  token: string,
  category: AccessTokenError['category'],
): Promise<void> {
  const error = await rejection(verifier, token);
  expect(error.kind).toBe('INVALID');
  expect(error.category).toBe(category);
  expect(error.message).not.toContain(token);
  expect(error.message).not.toContain(token.slice(0, 20));
}

describe('AccessTokenVerifier', () => {
  let identity: TestIdentity;
  let verifier: AccessTokenVerifier;

  beforeAll(async () => {
    identity = await TestIdentity.start();
  });

  afterAll(async () => {
    await identity.stop();
  });

  beforeEach(() => {
    verifier = new AccessTokenVerifier({
      jwksUrl: identity.jwksUrl,
      issuer: identity.issuer,
      audience: identity.audience,
      clockToleranceSeconds: 5,
    });
  });

  it('returns frozen claims with only the known roles for a valid token', async () => {
    const token = await identity.sign({
      sub: 'user-1',
      customerId: CUSTOMER_ID,
      roles: ['CUSTOMER', 'SUPPORT'],
    });
    const claims = await verifier.verify(token);
    expect(claims).toEqual({ sub: 'user-1', customerId: CUSTOMER_ID, roles: [Role.CUSTOMER] });
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.roles)).toBe(true);
  });

  it('accepts an admin token without customerId', async () => {
    const claims = await verifier.verify(await identity.adminToken());
    expect(claims.roles).toEqual([Role.ADMIN]);
    expect(claims.customerId).toBeUndefined();
  });

  it('makes no key set request until the first verification', () => {
    const before = identity.requestCount;
    new AccessTokenVerifier({
      jwksUrl: identity.jwksUrl,
      issuer: identity.issuer,
      audience: identity.audience,
      clockToleranceSeconds: 5,
    });
    expect(identity.requestCount).toBe(before);
  });

  it('rejects a token expired beyond the tolerance', async () => {
    const token = await identity.sign({}, { iat: now() - 60, expiresIn: 50 });
    await expectInvalid(verifier, token, 'expired');
  });

  it('accepts a token expired within the 5 s tolerance', async () => {
    const token = await identity.sign({ roles: ['ADMIN'] }, { iat: now() - 60, expiresIn: 58 });
    await expect(verifier.verify(token)).resolves.toMatchObject({ roles: [Role.ADMIN] });
  });

  it('rejects a tampered payload', async () => {
    const token = await identity.adminToken();
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        iss: identity.issuer,
        aud: identity.audience,
        sub: 'attacker',
        roles: ['ADMIN'],
        iat: now(),
        exp: now() + 600,
      }),
    ).toString('base64url');
    await expectInvalid(verifier, `${header}.${forged}.${signature}`, 'signature');
  });

  it('rejects a token signed by a key Identity does not hold, under a known kid', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await identity.sign({}, { key: privateKey });
    await expectInvalid(verifier, token, 'signature');
  });

  it('rejects alg none', async () => {
    await expectInvalid(verifier, identity.unsignedToken({ roles: ['ADMIN'] }), 'algorithm');
  });

  it('rejects HS256 with a random secret and with the public key PEM as secret', async () => {
    await expectInvalid(verifier, await identity.signHs256('some-secret'), 'algorithm');
    await expectInvalid(
      verifier,
      await identity.signHs256(await identity.publicKeyPem()),
      'algorithm',
    );
  });

  it('rejects a token without kid even though the set has a single key', async () => {
    const token = await identity.sign({ roles: ['ADMIN'] }, { header: { kid: null } });
    const error = await rejection(verifier, token);
    expect(error.kind).toBe('INVALID');
  });

  it('rejects an unknown kid', async () => {
    const token = await identity.sign({}, { header: { kid: 'unknown-kid' } });
    await expectInvalid(verifier, token, 'unknown-kid');
  });

  it('rejects a wrong issuer and a wrong audience', async () => {
    await expectInvalid(verifier, await identity.sign({}, { issuer: 'http://evil' }), 'issuer');
    await expectInvalid(verifier, await identity.sign({}, { audience: 'other' }), 'audience');
  });

  it('accepts an aud array containing the expected audience', async () => {
    const token = await identity.sign({ roles: ['ADMIN'] }, { audience: ['other', 'ecommerce'] });
    await expect(verifier.verify(token)).resolves.toMatchObject({ roles: [Role.ADMIN] });
  });

  it('rejects iat or nbf in the future beyond the tolerance', async () => {
    expect((await rejection(verifier, await identity.sign({}, { iat: now() + 60 }))).kind).toBe(
      'INVALID',
    );
    expect((await rejection(verifier, await identity.sign({}, { nbf: now() + 60 }))).kind).toBe(
      'INVALID',
    );
  });

  it('rejects bad claim shapes', async () => {
    await expectInvalid(verifier, await identity.sign({ sub: undefined }), 'claims');
    await expectInvalid(verifier, await identity.sign({ sub: '' }), 'claims');
    await expectInvalid(verifier, await identity.sign({ roles: 'ADMIN' }), 'claims');
    await expectInvalid(verifier, await identity.sign({ roles: ['ADMIN', 7] }), 'claims');
    await expectInvalid(verifier, await identity.sign({ roles: undefined }), 'claims');
    await expectInvalid(verifier, await identity.sign({ customerId: 'not-a-uuid' }), 'claims');
    await expectInvalid(verifier, await identity.sign({ customerId: 42 }), 'claims');
  });

  it('rejects a garbage string as malformed', async () => {
    await expectInvalid(verifier, 'garbage', 'malformed');
    await expectInvalid(verifier, 'a.b.c', 'malformed');
  });

  it('reports KEYS_UNAVAILABLE when no keys were ever loaded and Identity is down', async () => {
    identity.setAvailable(false);
    try {
      const token = await identity.adminToken();
      const error = await rejection(verifier, token);
      expect(error.kind).toBe('KEYS_UNAVAILABLE');
      expect(error.category).toBe('fetch');
      expect(error.message).not.toContain(token.slice(0, 20));
    } finally {
      identity.setAvailable(true);
    }
  });
});
