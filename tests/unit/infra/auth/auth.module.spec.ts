import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import configuration from '../../../../src/config/configuration';
import { AccessTokenVerifier } from '../../../../src/infra/auth/access-token.verifier';
import { AuthModule } from '../../../../src/infra/auth/auth.module';
import { TestIdentity } from '../../../support/test-identity';

function compile(): Promise<unknown> {
  return Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), AuthModule],
  }).compile();
}

describe('AuthModule', () => {
  let identity: TestIdentity;

  beforeAll(async () => {
    identity = await TestIdentity.start();
  });

  afterAll(async () => {
    await identity.stop();
  });

  beforeEach(() => {
    identity.applyEnv();
  });

  it('refuses to start without JWT_ISSUER', async () => {
    delete process.env.JWT_ISSUER;
    await expect(compile()).rejects.toThrow('JWT_ISSUER is required');
  });

  it('refuses to start without JWT_AUDIENCE', async () => {
    delete process.env.JWT_AUDIENCE;
    await expect(compile()).rejects.toThrow('JWT_AUDIENCE is required');
  });

  it('compiles with both set and fetches no keys', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), AuthModule],
    }).compile();
    await moduleRef.init();
    expect(moduleRef.get(AccessTokenVerifier)).toBeInstanceOf(AccessTokenVerifier);
    expect(identity.requestCount).toBe(0);
    await moduleRef.close();
  });
});
