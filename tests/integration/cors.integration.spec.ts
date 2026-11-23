import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import configuration from '../../src/config/configuration';
import { configureApp } from '../../src/app.setup';
import { graphqlModule } from '../../src/graphql/graphql.config';
import { OrdersController } from '../../src/controllers/orders.controller';
import { OrdersResolver } from '../../src/controllers/orders.resolver';
import { AuthModule } from '../../src/infra/auth/auth.module';
import { withTestIdentity } from '../support/auth-testing';

const ALLOWED_ORIGIN = 'https://shop.example.com';
const OTHER_ALLOWED_ORIGIN = 'http://localhost:5173';
const FOREIGN_ORIGIN = 'https://evil.example.com';
const ORDER_ID = '11111111-0000-4000-8000-000000000000';

/**
 * Builds the HTTP stack (REST controller + GraphQL endpoint) through `configureApp`, as `main.ts`
 * does, with `CORS_ALLOWED_ORIGINS` set to `allowedOrigins` while the configuration loads. The
 * command bus is stubbed: these tests are about headers, not order handling.
 */
async function buildApp(allowedOrigins: string | undefined): Promise<INestApplication> {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  if (allowedOrigins === undefined) {
    delete process.env.CORS_ALLOWED_ORIGINS;
  } else {
    process.env.CORS_ALLOWED_ORIGINS = allowedOrigins;
  }
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
        AuthModule,
        CqrsModule.forRoot(),
        graphqlModule(),
      ],
      controllers: [OrdersController],
      providers: [OrdersResolver],
    }).compile();

    jest
      .spyOn(moduleRef.get(CommandBus), 'execute')
      .mockResolvedValue({ orderId: ORDER_ID, status: 'CANCELLED' });

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
  } finally {
    if (previous === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = previous;
    }
  }
}

function corsHeaderNames(headers: Record<string, unknown>): string[] {
  return Object.keys(headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
}

/** Fake Identity for the whole file; REST calls send a token allowed on every route. */
const auth = withTestIdentity();

function restRequest(app: INestApplication, origin?: string): request.Test {
  const req = request(app.getHttpServer()).post(`/orders/${ORDER_ID}/cancel`).set(auth.headers);
  return origin === undefined ? req : req.set('Origin', origin);
}

function graphqlRequest(app: INestApplication, origin: string): request.Test {
  return request(app.getHttpServer())
    .post('/graphql')
    .set(auth.headers)
    .set('Origin', origin)
    .set('Content-Type', 'application/json')
    .send({ query: '{ __typename }' });
}

function preflight(app: INestApplication, path: string, origin: string): request.Test {
  return request(app.getHttpServer())
    .options(path)
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,authorization');
}

describe('CORS (REST and GraphQL)', () => {
  describe(`with CORS_ALLOWED_ORIGINS="${ALLOWED_ORIGIN}, ${OTHER_ALLOWED_ORIGIN}"`, () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(`${ALLOWED_ORIGIN}, ${OTHER_ALLOWED_ORIGIN}`);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('returns access-control-allow-origin to an allowed origin on a REST request', async () => {
      const res = await restRequest(app, ALLOWED_ORIGIN).expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers.vary).toMatch(/Origin/);
      expect(res.body).toEqual({ orderId: ORDER_ID, status: 'CANCELLED' });
    });

    it('returns access-control-allow-origin to an allowed origin on the GraphQL endpoint', async () => {
      const res = await graphqlRequest(app, OTHER_ALLOWED_ORIGIN).expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(OTHER_ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.body).toEqual({ data: { __typename: 'Query' } });
    });

    it.each(['/graphql', `/orders/${ORDER_ID}/cancel`])(
      'answers a preflight OPTIONS request to %s from an allowed origin',
      async (path) => {
        const res = await preflight(app, path, ALLOWED_ORIGIN).expect(204);

        expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
        expect(res.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
        expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Authorization');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      },
    );

    it('sends no CORS headers to a non-allowed origin on a REST request', async () => {
      const res = await restRequest(app, FOREIGN_ORIGIN).expect(200);

      expect(corsHeaderNames(res.headers)).toEqual([]);
    });

    it('sends no CORS headers to a non-allowed origin on the GraphQL endpoint', async () => {
      const res = await graphqlRequest(app, FOREIGN_ORIGIN).expect(200);

      expect(corsHeaderNames(res.headers)).toEqual([]);
    });

    it('sends no CORS headers to a preflight from a non-allowed origin', async () => {
      const res = await preflight(app, '/graphql', FOREIGN_ORIGIN);

      expect(res.status).not.toBe(204);
      expect(corsHeaderNames(res.headers)).toEqual([]);
    });

    it('does not treat a prefix or suffix of an allowed origin as allowed', async () => {
      const prefix = await restRequest(app, `${ALLOWED_ORIGIN}.evil.example`);
      const scheme = await restRequest(app, 'http://shop.example.com');

      expect(corsHeaderNames(prefix.headers)).toEqual([]);
      expect(corsHeaderNames(scheme.headers)).toEqual([]);
    });

    it('sends no CORS headers to a same-origin request (no Origin header)', async () => {
      const res = await restRequest(app).expect(200);

      expect(corsHeaderNames(res.headers)).toEqual([]);
    });
  });

  describe.each([
    ['unset', undefined],
    ['empty', ''],
  ])('with CORS_ALLOWED_ORIGINS %s', (_label, value) => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(value);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('sends no CORS headers to any origin on REST or GraphQL', async () => {
      const rest = await restRequest(app, ALLOWED_ORIGIN).expect(200);
      const graphql = await graphqlRequest(app, ALLOWED_ORIGIN).expect(200);

      expect(corsHeaderNames(rest.headers)).toEqual([]);
      expect(corsHeaderNames(graphql.headers)).toEqual([]);
    });

    it('does not answer a preflight request', async () => {
      const res = await preflight(app, '/graphql', ALLOWED_ORIGIN);

      expect(res.status).not.toBe(204);
      expect(corsHeaderNames(res.headers)).toEqual([]);
    });
  });
});
