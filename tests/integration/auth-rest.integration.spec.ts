import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { configureApp } from '../../src/app.setup';
import { setupSwagger } from '../../src/app.swagger';
import { bearer, withTestIdentity } from '../support/auth-testing';

jest.setTimeout(180_000);

const UNAUTHORIZED_BODY = '{"statusCode":401,"message":"Unauthorized"}';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * US-11 / US1: every REST route needs a valid Identity token, and every failure gets the very
 * same 401. Boots the full AppModule (Kafka consumers, dead-letter worker off; MongoDB lazy and
 * unreachable, as the REST write path never reads it).
 */
describe('REST authentication (integration)', () => {
  const auth = withTestIdentity();
  const savedEnv: Record<string, string | undefined> = {};
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    setEnv({
      DB_HOST: container.getHost(),
      DB_PORT: String(container.getPort()),
      DB_USERNAME: container.getUsername(),
      DB_PASSWORD: container.getPassword(),
      DB_NAME: container.getDatabase(),
      DB_MIGRATIONS_RUN: 'true',
      MONGO_URI: 'mongodb://127.0.0.1:1/orders_read_unused',
      KAFKA_BROKERS: '127.0.0.1:1',
      KAFKA_CONSUMER_ENABLED: 'false',
      DEAD_LETTER_RETRY_ENABLED: 'false',
    });
    // Imported here so the configuration is read after the env above and withTestIdentity's.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function cancel(authorization?: string): request.Test {
    const req = request(app.getHttpServer()).post(`/orders/${randomUUID()}/cancel`);
    return authorization === undefined ? req : req.set('Authorization', authorization);
  }

  /** Every rejected token, as `Authorization` header values (undefined: no header). */
  async function rejectedHeaders(): Promise<[string, string | undefined][]> {
    const identity = auth.identity;
    const admin = { roles: ['ADMIN'] };
    const valid = await identity.sign(admin);
    const [header, , signature] = valid.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...admin, sub: 'x', iss: identity.issuer, aud: identity.audience }),
    ).toString('base64url');
    const { privateKey: strangerKey } = await generateKeyPair('RS256');
    const withBearer = async (token: Promise<string> | string): Promise<string> =>
      `Bearer ${await token}`;

    return [
      ['no header', undefined],
      ['Basic scheme', 'Basic x'],
      ['garbage token', 'Bearer garbage'],
      ['tampered payload', `Bearer ${header}.${forgedPayload}.${signature}`],
      ['key Identity does not hold', await withBearer(identity.sign(admin, { key: strangerKey }))],
      ['unknown kid', await withBearer(identity.sign(admin, { header: { kid: 'unknown' } }))],
      ['alg none', await withBearer(identity.unsignedToken(admin))],
      ['HS256', await withBearer(identity.signHs256('secret', admin))],
      [
        'HS256 with public key',
        await withBearer(identity.signHs256(await identity.publicKeyPem(), admin)),
      ],
      ['wrong issuer', await withBearer(identity.sign(admin, { issuer: 'http://evil' }))],
      ['wrong audience', await withBearer(identity.sign(admin, { audience: 'other' }))],
      [
        'expired 10 s ago',
        await withBearer(identity.sign(admin, { iat: now() - 70, expiresIn: 60 })),
      ],
      ['no kid', await withBearer(identity.sign(admin, { header: { kid: null } }))],
    ];
  }

  it('answers every rejected token with byte-identical 401s', async () => {
    const answers = [];
    for (const [label, authorization] of await rejectedHeaders()) {
      const response = await cancel(authorization);
      answers.push({
        label,
        status: response.status,
        wwwAuthenticate: response.headers['www-authenticate'],
        body: response.text,
      });
    }
    for (const answer of answers) {
      expect(answer).toEqual({
        label: answer.label,
        status: 401,
        wwwAuthenticate: 'Bearer',
        body: UNAUTHORIZED_BODY,
      });
    }
  });

  it('accepts a token expired within the clock tolerance', async () => {
    const token = await auth.identity.sign(
      { roles: ['ADMIN'] },
      { iat: now() - 62, expiresIn: 60 },
    );
    const response = await cancel(`Bearer ${token}`);
    expect(response.status).toBe(404);
  });

  it('lets a valid token reach the endpoint', async () => {
    const response = await request(app.getHttpServer())
      .post(`/orders/${randomUUID()}/cancel`)
      .set(auth.headers);
    expect(response.status).toBe(404);
  });

  it('checks the token before the body (401, not 400)', async () => {
    const response = await request(app.getHttpServer()).post('/orders').send({ items: 'nope' });
    expect(response.status).toBe(401);
    expect(response.text).toBe(UNAUTHORIZED_BODY);
  });

  it('still validates the body for an authenticated caller', async () => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(bearer(await auth.identity.customerAdminToken(randomUUID())))
      .send({ items: 'nope' });
    expect(response.status).toBe(400);
  });

  it('serves the Swagger document without a token', async () => {
    const response = await request(app.getHttpServer()).get('/api-json');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('openapi');
  });
});
