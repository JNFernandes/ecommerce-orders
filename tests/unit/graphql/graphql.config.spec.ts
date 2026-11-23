import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { buildGraphqlOptions } from '../../../src/graphql/graphql.config';
import { graphqlAuthPlugin } from '../../../src/graphql/graphql-auth.plugin';
import { buildGraphqlContext, GraphqlContext } from '../../../src/graphql/graphql-context';
import { AccessTokenClaims } from '../../../src/infra/auth/access-token-claims';
import { AccessTokenError } from '../../../src/infra/auth/access-token.error';
import { AccessTokenVerifier } from '../../../src/infra/auth/access-token.verifier';
import { Role } from '../../../src/infra/auth/role.enum';

const CLAIMS: AccessTokenClaims = { sub: 'user-1', roles: [Role.ADMIN] };

function config(graphql: { devTools: boolean } | undefined): ConfigService {
  return { get: jest.fn().mockReturnValue(graphql) } as unknown as ConfigService;
}

function verifierMock(): { verifier: AccessTokenVerifier; verify: jest.Mock } {
  const verify = jest.fn<Promise<AccessTokenClaims>, [string]>().mockResolvedValue(CLAIMS);
  return { verifier: { verify } as unknown as AccessTokenVerifier, verify };
}

function requestWith(authorization?: string): Request {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as Request;
}

describe('buildGraphqlOptions', () => {
  const { verifier } = verifierMock();

  it('should serve /graphql from an in-memory, sorted schema without the deprecated playground', () => {
    const options = buildGraphqlOptions(config({ devTools: true }), verifier);

    expect(options).toMatchObject({
      path: '/graphql',
      autoSchemaFile: true,
      sortSchema: true,
      playground: false,
    });
  });

  it('should enable introspection and the Apollo Sandbox outside production, behind the auth plugin', () => {
    const options = buildGraphqlOptions(config({ devTools: true }), verifier);

    expect(options.introspection).toBe(true);
    expect(options.plugins).toHaveLength(2);
    expect(options.plugins?.[0]).toBe(graphqlAuthPlugin);
  });

  it('should disable introspection and every landing page in production, keeping the auth plugin', () => {
    const options = buildGraphqlOptions(config({ devTools: false }), verifier);

    expect(options.introspection).toBe(false);
    expect(options.plugins).toEqual([graphqlAuthPlugin]);
  });

  it('should default to the production behaviour when the graphql config is missing', () => {
    const options = buildGraphqlOptions(config(undefined), verifier);

    expect(options.introspection).toBe(false);
    expect(options.plugins).toEqual([graphqlAuthPlugin]);
  });

  it('should build the request context with the verifier', async () => {
    const mock = verifierMock();
    const options = buildGraphqlOptions(config(undefined), mock.verifier);
    const context = options.context as (args: { req: Request }) => Promise<GraphqlContext>;

    const value = await context({ req: requestWith('Bearer the-token') });

    expect(value.user).toBe(CLAIMS);
    expect(mock.verify).toHaveBeenCalledWith('the-token');
  });
});

describe('buildGraphqlContext', () => {
  it('should hold the verified caller and no error for a valid token', async () => {
    const { verifier, verify } = verifierMock();
    const req = requestWith('Bearer the-token');

    const value = await buildGraphqlContext(verifier)({ req });

    expect(value).toEqual({ req, user: CLAIMS, authError: null });
    expect(value.req).toBe(req);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('should hold the verifier error and no user for an invalid token', async () => {
    const { verifier, verify } = verifierMock();
    const rejected = new AccessTokenError('INVALID', 'signature');
    verify.mockRejectedValue(rejected);

    const value = await buildGraphqlContext(verifier)({ req: requestWith('Bearer bad') });

    expect(value.user).toBeNull();
    expect(value.authError).toBe(rejected);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'Basic x', 'Bearer'])(
    'should record INVALID/missing without calling the verifier for header %p',
    async (header) => {
      const { verifier, verify } = verifierMock();

      const value = await buildGraphqlContext(verifier)({ req: requestWith(header) });

      expect(value.user).toBeNull();
      expect(value.authError).toMatchObject({ kind: 'INVALID', category: 'missing' });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('should rethrow errors that are not token rejections', async () => {
    const { verifier, verify } = verifierMock();
    const bug = new Error('bug');
    verify.mockRejectedValue(bug);

    await expect(buildGraphqlContext(verifier)({ req: requestWith('Bearer t') })).rejects.toBe(bug);
  });
});
