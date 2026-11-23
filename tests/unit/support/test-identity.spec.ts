import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { TestIdentity } from '../../support/test-identity';

describe('TestIdentity', () => {
  let identity: TestIdentity;

  beforeAll(async () => {
    identity = await TestIdentity.start();
  });

  afterAll(async () => {
    await identity.stop();
  });

  it('serves a key set that verifies the tokens it signs', async () => {
    const token = await identity.customerToken('3f0c8f8e-4c55-4a59-9a0b-0f1b2a3c4d5e');
    const keySet = createRemoteJWKSet(new URL(identity.jwksUrl));
    const { payload, protectedHeader } = await jwtVerify(token, keySet, {
      issuer: identity.issuer,
      audience: identity.audience,
      algorithms: ['RS256'],
    });
    expect(protectedHeader.kid).toBe(identity.currentKid);
    expect(payload.roles).toEqual(['CUSTOMER']);
    expect(identity.requestCount).toBe(1);
  });

  it('can leave the kid out and build HS256 and unsigned tokens', async () => {
    const noKid = await identity.sign({}, { header: { kid: null } });
    expect(decodeProtectedHeader(noKid).kid).toBeUndefined();
    expect(decodeProtectedHeader(await identity.signHs256('secret')).alg).toBe('HS256');
    expect(decodeProtectedHeader(identity.unsignedToken()).alg).toBe('none');
  });

  it('rotates keys and answers 500 while unavailable', async () => {
    const oldKid = identity.currentKid;
    const newKid = await identity.rotate();
    const set = (await (await fetch(identity.jwksUrl)).json()) as { keys: { kid: string }[] };
    expect(set.keys.map((key) => key.kid)).toEqual([oldKid, newKid]);
    identity.setAvailable(false);
    expect((await fetch(identity.jwksUrl)).status).toBe(500);
    identity.setAvailable(true);
  });

  it('points the auth environment variables at itself', () => {
    identity.applyEnv();
    expect(process.env.IDENTITY_JWKS_URL).toBe(identity.jwksUrl);
    expect(process.env.JWT_ISSUER).toBe(identity.issuer);
    expect(process.env.JWT_AUDIENCE).toBe(identity.audience);
  });
});
