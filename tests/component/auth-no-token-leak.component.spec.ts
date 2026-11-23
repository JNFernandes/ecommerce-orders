import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { configureApp } from '../../src/app.setup';
import { setupSwagger } from '../../src/app.swagger';
import { withTestIdentity } from '../support/auth-testing';

jest.setTimeout(300_000);

const LOGGER_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * US-11 / SC-006: no token, nor its first 20 characters, ever appears in a log line, in
 * stdout/stderr or in a response body, whatever the outcome: REST 401 (every rejection reason),
 * 403, 503, and GraphQL `UNAUTHENTICATED` / `SERVICE_UNAVAILABLE` / `FORBIDDEN`. Boots the full
 * AppModule with Identity unavailable at first (Kafka consumers and dead-letter worker off,
 * MongoDB unreachable: no request here gets past the auth checks into the read model).
 */
describe('No token in logs or responses (component)', () => {
  const auth = withTestIdentity();
  const savedEnv: Record<string, string | undefined> = {};
  const captured: string[] = [];
  const bodies: string[] = [];
  const tokens: string[] = [];
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  /** Records everything logged or written to stdout/stderr. */
  function captureOutput(): void {
    for (const method of LOGGER_METHODS) {
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
        captured.push(String(chunk));
        return original(chunk as string, ...rest);
      }) as typeof stream.write);
    }
  }

  beforeAll(async () => {
    captureOutput();
    auth.identity.setAvailable(false);
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
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** Remembers a token so the final check looks for it. */
  async function used(token: Promise<string> | string): Promise<string> {
    const value = await token;
    tokens.push(value);
    return value;
  }

  async function rest(token: string, path = `/orders/${randomUUID()}/cancel`): Promise<number> {
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 'p-1', quantity: 1, unitPrice: 1 }] });
    bodies.push(response.text);
    return response.status;
  }

  async function graphql(token: string): Promise<string | undefined> {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: '{ orders { totalCount } }' });
    bodies.push(response.text);
    const body = response.body as { errors?: Array<{ extensions?: { code?: string } }> };
    return body.errors?.[0]?.extensions?.code;
  }

  it('answers 503 and SERVICE_UNAVAILABLE while no keys were ever loaded', async () => {
    const token = await used(auth.identity.customerToken(randomUUID()));

    expect(await rest(token, '/orders')).toBe(503);
    expect(await graphql(token)).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 401 and UNAUTHENTICATED for every rejected token', async () => {
    auth.identity.setAvailable(true);
    const identity = auth.identity;
    const admin = { roles: ['ADMIN'] };
    const valid = await used(identity.sign(admin));
    const [header, , signature] = valid.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...admin, sub: 'x', iss: identity.issuer, aud: identity.audience }),
    ).toString('base64url');
    const { privateKey: strangerKey } = await generateKeyPair('RS256');

    const rejected = [
      'garbage-token-value-that-is-long-enough',
      `${header}.${forgedPayload}.${signature}`,
      await identity.sign(admin, { key: strangerKey }),
      await identity.sign(admin, { header: { kid: 'unknown' } }),
      identity.unsignedToken(admin),
      await identity.signHs256('secret', admin),
      await identity.signHs256(await identity.publicKeyPem(), admin),
      await identity.sign(admin, { issuer: 'http://evil' }),
      await identity.sign(admin, { audience: 'other' }),
      await identity.sign(admin, { iat: now() - 70, expiresIn: 60 }),
      await identity.sign(admin, { header: { kid: null } }),
    ];
    for (const token of rejected) {
      await used(token);
      expect(await rest(token)).toBe(401);
      expect(await graphql(token)).toBe('UNAUTHENTICATED');
    }
  });

  it('answers 403 and FORBIDDEN to a valid token without the needed role', async () => {
    expect(await rest(await used(auth.identity.adminToken()), '/orders')).toBe(403);
    expect(await graphql(await used(auth.identity.sign({ roles: ['GUEST'] })))).toBe('FORBIDDEN');
  });

  it('never writes a token to the logs, the console or a response body', () => {
    expect(tokens.length).toBeGreaterThan(10);
    expect(captured.some((line) => line.includes('Rejected'))).toBe(true);
    const output = [...captured, ...bodies].join('\n');
    for (const token of tokens) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(token.slice(0, 20));
    }
  });
});
