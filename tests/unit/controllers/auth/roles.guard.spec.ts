import { ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Request } from 'express';
import { GraphQLError } from 'graphql';
import { GraphqlContext } from '../../../../src/graphql/graphql-context';
import { AccessTokenClaims } from '../../../../src/infra/auth/access-token-claims';
import { Role } from '../../../../src/infra/auth/role.enum';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles, ROLES_KEY } from '../../../../src/controllers/auth/roles.decorator';
import { RolesGuard } from '../../../../src/controllers/auth/roles.guard';

const CUSTOMER_ID = '3f0c8f8e-4c55-4a59-9a0b-0f1b2a3c4d5e';

class Fixture {
  @Roles(Role.CUSTOMER)
  customerOnly(): void {}

  @Roles(Role.ADMIN)
  adminOnly(): void {}

  @Roles(Role.CUSTOMER, Role.ADMIN)
  customerOrAdmin(): void {}

  @Public()
  open(): void {}

  noMetadata(): void {}

  @SetMetadata(ROLES_KEY, [])
  emptyRoles(): void {}
}

@Roles(Role.ADMIN)
class AdminFixture {
  inherited(): void {}

  @Roles(Role.CUSTOMER)
  overridden(): void {}
}

type Handler = (this: void) => void;

function contextFor(
  cls: abstract new () => object,
  handler: Handler,
  user: AccessTokenClaims | undefined,
  type = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function claims(roles: Role[], customerId?: string): AccessTokenClaims {
  return { sub: 'user-1', roles, ...(customerId === undefined ? {} : { customerId }) };
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const proto = Fixture.prototype;
  const check = (handler: Handler, user: AccessTokenClaims | undefined): boolean =>
    guard.canActivate(contextFor(Fixture, handler, user));

  it('allows a customer with a customerId on a CUSTOMER route', () => {
    expect(check(proto.customerOnly, claims([Role.CUSTOMER], CUSTOMER_ID))).toBe(true);
  });

  it('denies a CUSTOMER token without customerId on a CUSTOMER route', () => {
    expect(() => check(proto.customerOnly, claims([Role.CUSTOMER]))).toThrow(ForbiddenException);
  });

  it('denies an admin on a CUSTOMER route and a customer on an ADMIN route', () => {
    expect(() => check(proto.customerOnly, claims([Role.ADMIN]))).toThrow(ForbiddenException);
    expect(() => check(proto.adminOnly, claims([Role.CUSTOMER], CUSTOMER_ID))).toThrow(
      ForbiddenException,
    );
  });

  it('allows an admin on an ADMIN route', () => {
    expect(check(proto.adminOnly, claims([Role.ADMIN]))).toBe(true);
  });

  it('allows CUSTOMER+ADMIN without customerId as ADMIN on a CUSTOMER-or-ADMIN route', () => {
    expect(check(proto.customerOrAdmin, claims([Role.CUSTOMER, Role.ADMIN]))).toBe(true);
  });

  it('denies a token with no known roles', () => {
    expect(() => check(proto.customerOrAdmin, claims([], CUSTOMER_ID))).toThrow(ForbiddenException);
  });

  it('denies when no caller is attached', () => {
    expect(() => check(proto.customerOrAdmin, undefined)).toThrow(ForbiddenException);
  });

  it('denies every caller when the roles metadata is empty', () => {
    expect(() => check(proto.emptyRoles, claims([Role.ADMIN]))).toThrow(ForbiddenException);
  });

  it('allows @Public and handlers without role metadata', () => {
    expect(check(proto.open, undefined)).toBe(true);
    expect(check(proto.noMetadata, undefined)).toBe(true);
  });

  it('honours class-level @Roles, with method-level @Roles taking precedence', () => {
    const admin = claims([Role.ADMIN]);
    const customer = claims([Role.CUSTOMER], CUSTOMER_ID);
    const adminProto = AdminFixture.prototype;
    expect(guard.canActivate(contextFor(AdminFixture, adminProto.inherited, admin))).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(AdminFixture, adminProto.inherited, customer)),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor(AdminFixture, adminProto.overridden, customer))).toBe(true);
  });

  it('lets other transports through', () => {
    expect(guard.canActivate(contextFor(Fixture, proto.adminOnly, undefined, 'rpc'))).toBe(true);
  });

  describe('GraphQL', () => {
    function graphqlCheck(handler: Handler, user: AccessTokenClaims | null): boolean {
      const context: GraphqlContext = {
        req: {} as Request,
        user,
        authError: null,
      };
      const host = new ExecutionContextHost([undefined, {}, context, undefined], Fixture, handler);
      host.setType('graphql');
      return guard.canActivate(host);
    }

    it('applies the same effective-roles rule to the caller in the GraphQL context', () => {
      expect(graphqlCheck(proto.customerOrAdmin, claims([Role.ADMIN]))).toBe(true);
      expect(graphqlCheck(proto.customerOrAdmin, claims([Role.CUSTOMER], CUSTOMER_ID))).toBe(true);
    });

    it.each([
      ['no known roles', claims([], CUSTOMER_ID)],
      ['CUSTOMER without customerId', claims([Role.CUSTOMER])],
      ['no caller', null],
    ])('denies %s with a FORBIDDEN GraphQL error', (_label, user) => {
      let thrown: unknown;
      try {
        graphqlCheck(proto.customerOrAdmin, user);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GraphQLError);
      expect(thrown).toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    });
  });
});
