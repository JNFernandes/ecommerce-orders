import { InternalServerErrorException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Request } from 'express';
import { currentUserFactory } from '../../../../src/controllers/auth/current-user.decorator';
import { GraphqlContext } from '../../../../src/graphql/graphql-context';
import { AccessTokenClaims } from '../../../../src/infra/auth/access-token-claims';
import { AccessTokenError } from '../../../../src/infra/auth/access-token.error';
import { Role } from '../../../../src/infra/auth/role.enum';

const CLAIMS: AccessTokenClaims = {
  sub: 'user-1',
  customerId: '3f0c8f8e-4c55-4a59-9a0b-0f1b2a3c4d5e',
  roles: [Role.CUSTOMER],
};

class Fixture {
  handler(): void {}
}

function httpContext(user: AccessTokenClaims | undefined): ExecutionContextHost {
  const request = { user } as unknown as Request;
  const host = new ExecutionContextHost([request, {}], Fixture, Fixture.prototype.handler);
  host.setType('http');
  return host;
}

function graphqlContext(user: AccessTokenClaims | null): ExecutionContextHost {
  const context: GraphqlContext = {
    req: {} as Request,
    user,
    authError: user === null ? new AccessTokenError('INVALID', 'missing') : null,
  };
  const host = new ExecutionContextHost(
    [undefined, {}, context, undefined],
    Fixture,
    Fixture.prototype.handler,
  );
  host.setType('graphql');
  return host;
}

describe('currentUserFactory (@CurrentUser)', () => {
  it('returns the caller attached to an HTTP request', () => {
    expect(currentUserFactory(undefined, httpContext(CLAIMS))).toBe(CLAIMS);
  });

  it('returns the caller held by the GraphQL context', () => {
    expect(currentUserFactory(undefined, graphqlContext(CLAIMS))).toBe(CLAIMS);
  });

  it('throws a 500 when no caller is attached (the guard did not run)', () => {
    expect(() => currentUserFactory(undefined, httpContext(undefined))).toThrow(
      InternalServerErrorException,
    );
    expect(() => currentUserFactory(undefined, graphqlContext(null))).toThrow(
      InternalServerErrorException,
    );
  });

  it('throws a 500 for other transports', () => {
    const host = new ExecutionContextHost([], Fixture, Fixture.prototype.handler);
    host.setType('rpc');

    expect(() => currentUserFactory(undefined, host)).toThrow(InternalServerErrorException);
  });
});
