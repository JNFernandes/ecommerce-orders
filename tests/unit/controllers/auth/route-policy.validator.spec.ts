import 'reflect-metadata';
import { Controller, Get, Post, SetMetadata, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Query, Resolver } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles, ROLES_KEY } from '../../../../src/controllers/auth/roles.decorator';
import { RoutePolicyValidator } from '../../../../src/controllers/auth/route-policy.validator';
import { OrdersController } from '../../../../src/controllers/orders.controller';
import { OrdersResolver } from '../../../../src/controllers/orders.resolver';
import { Role } from '../../../../src/infra/auth/role.enum';

@Controller('fixture')
class FixtureController {
  @Get()
  handler(): string {
    return 'open';
  }

  /** Not a route: helpers without route metadata are ignored. */
  helper(): string {
    return 'helper';
  }
}

@Controller('fixture-ok')
class AnnotatedFixtureController {
  @Get('public')
  @Public()
  open(): string {
    return 'public';
  }

  @Post('admin')
  @Roles(Role.ADMIN)
  admin(): string {
    return 'admin';
  }
}

@Controller('fixture-class')
@Roles(Role.CUSTOMER)
class ClassRolesFixtureController {
  @Get()
  list(): string {
    return 'list';
  }
}

@Controller('fixture-empty')
class EmptyRolesFixtureController {
  @Get()
  @SetMetadata(ROLES_KEY, [])
  handler(): string {
    return 'empty';
  }
}

@Resolver()
class FixtureResolver {
  @Query(() => String)
  fixtureQuery(): string {
    return 'open';
  }
}

@Resolver()
@Roles(Role.CUSTOMER, Role.ADMIN)
class AnnotatedFixtureResolver {
  @Query(() => String)
  fixtureQuery(): string {
    return 'ok';
  }
}

/** Compiles a module holding these classes and runs its lifecycle hooks (the validator's check). */
async function init(controllers: Type[], providers: Type[] = []): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers,
    providers: [
      RoutePolicyValidator,
      ...providers,
      { provide: CommandBus, useValue: {} },
      { provide: QueryBus, useValue: {} },
    ],
  }).compile();
  try {
    await moduleRef.init();
  } finally {
    await moduleRef.close();
  }
}

describe('RoutePolicyValidator (default deny at startup)', () => {
  it('rejects a controller route without @Public or @Roles, naming Class.method', async () => {
    await expect(init([FixtureController])).rejects.toThrow('FixtureController.handler');
  });

  it('does not report non-route methods', async () => {
    await expect(init([FixtureController])).rejects.not.toThrow('FixtureController.helper');
  });

  it('rejects a resolver query without @Public or @Roles, naming Class.method', async () => {
    await expect(init([], [FixtureResolver])).rejects.toThrow('FixtureResolver.fixtureQuery');
  });

  it('lists every offender in one error', async () => {
    await expect(init([FixtureController], [FixtureResolver])).rejects.toThrow(
      /FixtureController\.handler.*FixtureResolver\.fixtureQuery/,
    );
  });

  it('rejects empty @Roles metadata', async () => {
    await expect(init([EmptyRolesFixtureController])).rejects.toThrow(
      'EmptyRolesFixtureController.handler',
    );
  });

  it('accepts @Public, method-level @Roles and class-level @Roles', async () => {
    await expect(
      init([AnnotatedFixtureController, ClassRolesFixtureController], [AnnotatedFixtureResolver]),
    ).resolves.toBeUndefined();
  });

  it("accepts the application's own controller and resolver", async () => {
    await expect(init([OrdersController], [OrdersResolver])).resolves.toBeUndefined();
  });
});
