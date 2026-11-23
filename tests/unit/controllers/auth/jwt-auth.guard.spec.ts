import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../../src/controllers/auth/jwt-auth.guard';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { AccessTokenClaims } from '../../../../src/infra/auth/access-token-claims';
import { AccessTokenError } from '../../../../src/infra/auth/access-token.error';
import { AccessTokenVerifier } from '../../../../src/infra/auth/access-token.verifier';
import { Role } from '../../../../src/infra/auth/role.enum';

class Fixture {
  @Public()
  open(): void {}

  closed(): void {}
}

@Public()
class PublicFixture {
  anything(): void {}
}

const CLAIMS: AccessTokenClaims = { sub: 'user-1', roles: [Role.ADMIN] };

function contextFor(
  cls: abstract new () => object,
  handler: (this: void) => void,
  request: Partial<Request>,
  type = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestWith(authorization?: string): Partial<Request> {
  return { headers: authorization === undefined ? {} : { authorization } };
}

describe('JwtAuthGuard', () => {
  let verify: jest.Mock<Promise<AccessTokenClaims>, [string]>;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verify = jest.fn<Promise<AccessTokenClaims>, [string]>().mockResolvedValue(CLAIMS);
    guard = new JwtAuthGuard(new Reflector(), { verify } as unknown as AccessTokenVerifier);
  });

  it('skips @Public handlers and @Public classes without calling the verifier', async () => {
    await expect(
      guard.canActivate(contextFor(Fixture, Fixture.prototype.open, requestWith())),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor(PublicFixture, PublicFixture.prototype.anything, requestWith())),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Basic x', 'Bearer', 'Bearer a b'])(
    'rejects header %p as INVALID/missing',
    async (header) => {
      const promise = guard.canActivate(
        contextFor(Fixture, Fixture.prototype.closed, requestWith(header)),
      );
      await expect(promise).rejects.toBeInstanceOf(AccessTokenError);
      await expect(promise).rejects.toMatchObject({ kind: 'INVALID', category: 'missing' });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('propagates the verifier error', async () => {
    verify.mockRejectedValue(new AccessTokenError('KEYS_UNAVAILABLE', 'fetch'));
    await expect(
      guard.canActivate(contextFor(Fixture, Fixture.prototype.closed, requestWith('Bearer t'))),
    ).rejects.toMatchObject({ kind: 'KEYS_UNAVAILABLE' });
  });

  it('attaches the verified claims to the request', async () => {
    const request = requestWith('Bearer the-token');
    await expect(
      guard.canActivate(contextFor(Fixture, Fixture.prototype.closed, request)),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('the-token');
    expect(request.user).toBe(CLAIMS);
  });

  it('lets non-HTTP contexts through (GraphQL is handled separately)', async () => {
    await expect(
      guard.canActivate(contextFor(Fixture, Fixture.prototype.closed, requestWith(), 'graphql')),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
});
