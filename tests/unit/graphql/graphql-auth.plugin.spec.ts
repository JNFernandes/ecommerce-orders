import { Logger } from '@nestjs/common';
import { Request } from 'express';
import { GraphQLError } from 'graphql';
import { graphqlAuthPlugin } from '../../../src/graphql/graphql-auth.plugin';
import { GraphqlContext } from '../../../src/graphql/graphql-context';
import { AccessTokenClaims } from '../../../src/infra/auth/access-token-claims';
import { AccessTokenError } from '../../../src/infra/auth/access-token.error';
import { Role } from '../../../src/infra/auth/role.enum';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature-part';
const CLAIMS: AccessTokenClaims = { sub: 'user-1', roles: [Role.ADMIN] };

function contextValue(
  user: AccessTokenClaims | null,
  authError: AccessTokenError | null,
): GraphqlContext {
  const req = { headers: { authorization: `Bearer ${TOKEN}` } } as unknown as Request;
  return { req, user, authError };
}

async function rejection(context: GraphqlContext): Promise<GraphQLError> {
  const listener = await graphqlAuthPlugin.requestDidStart();
  try {
    await listener.didResolveOperation({ contextValue: context });
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    return error as GraphQLError;
  }
  throw new Error('expected the operation to be rejected');
}

describe('graphqlAuthPlugin', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each(['signature', 'expired', 'unknown-kid', 'missing'] as const)(
    'rejects an INVALID/%s token with UNAUTHENTICATED and HTTP 200',
    async (category) => {
      const error = await rejection(contextValue(null, new AccessTokenError('INVALID', category)));

      expect(error.message).toBe('Unauthorized');
      expect(error.extensions.code).toBe('UNAUTHENTICATED');
      expect(error.extensions.http).toEqual({ status: 200 });
    },
  );

  it('rejects with SERVICE_UNAVAILABLE when Identity keys are unavailable', async () => {
    const error = await rejection(
      contextValue(null, new AccessTokenError('KEYS_UNAVAILABLE', 'fetch')),
    );

    expect(error.message).toBe('Authentication is temporarily unavailable, please retry');
    expect(error.extensions.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects with UNAUTHENTICATED when there is no user and no recorded error', async () => {
    const error = await rejection(contextValue(null, null));

    expect(error.extensions.code).toBe('UNAUTHENTICATED');
  });

  it('lets a verified caller through', async () => {
    const listener = await graphqlAuthPlugin.requestDidStart();

    await expect(
      listener.didResolveOperation({ contextValue: contextValue(CLAIMS, null) }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the category only and never the token', async () => {
    const error = await rejection(contextValue(null, new AccessTokenError('INVALID', 'signature')));

    expect(warn).toHaveBeenCalledWith('Rejected GraphQL request: signature');
    const logged = JSON.stringify(warn.mock.calls);
    const answered = JSON.stringify(error.toJSON());
    for (const text of [logged, answered]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN.slice(0, 20));
    }
  });
});
