import { Injectable, OnModuleInit } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { RESOLVER_NAME_METADATA, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';
import { Role } from '../../infra/auth/role.enum';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/** A class whose methods may be route or resolver handlers. */
type HandlerClass = abstract new (...args: never[]) => object;

/** A method of a controller or resolver. */
type HandlerMethod = (...args: never[]) => unknown;

/** Members of a prototype, by name. */
type HandlerHost = Record<string, unknown>;

/**
 * Default deny, checked at startup (US-11 FR-013, research R13): every REST route handler and
 * every GraphQL resolver handler must carry `@Public()` or a non-empty `@Roles(...)`, on the
 * method or its class. Otherwise `app.init()` fails with one error naming each offender as
 * `Class.method`, so a route can never ship open by accident. Makes no network call.
 */
@Injectable()
export class RoutePolicyValidator implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** Runs the check when the application initialises. */
  onModuleInit(): void {
    const offenders = [
      ...this.offendersIn(
        this.discovery.getControllers(),
        (method) => this.reflector.get<unknown>(PATH_METADATA, method) !== undefined,
      ),
      ...this.offendersIn(this.discovery.getProviders(), (method) =>
        this.isResolverHandler(method),
      ),
    ];
    if (offenders.length > 0) {
      throw new Error(
        'Every route and resolver needs @Public() or @Roles(...); missing on: ' +
          offenders.join(', '),
      );
    }
  }

  /** Names (`Class.method`) of the handlers in these wrappers that have no access rule. */
  private offendersIn(
    wrappers: readonly InstanceWrapper[],
    isHandler: (method: HandlerMethod) => boolean,
  ): string[] {
    const offenders: string[] = [];
    for (const wrapper of wrappers) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) {
        continue;
      }
      const type = instance.constructor as HandlerClass;
      const prototype = Object.getPrototypeOf(instance) as HandlerHost;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const member = prototype[name];
        if (typeof member !== 'function') {
          continue;
        }
        const method = member as HandlerMethod;
        if (!isHandler(method) || this.hasRule(method, type)) {
          continue;
        }
        offenders.push(`${type.name}.${name}`);
      }
    }
    return offenders;
  }

  /**
   * Whether a method is a GraphQL resolver handler: `@Query`/`@Mutation`/`@Subscription` set the
   * resolver type (their name may be undefined), `@ResolveField` sets the name.
   */
  private isResolverHandler(method: HandlerMethod): boolean {
    return (
      this.reflector.get<unknown>(RESOLVER_TYPE_METADATA, method) !== undefined ||
      this.reflector.get<unknown>(RESOLVER_NAME_METADATA, method) !== undefined
    );
  }

  /** Whether the handler or its class is `@Public()` or has at least one role. */
  private hasRule(method: HandlerMethod, type: HandlerClass): boolean {
    const targets = [method, type];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }
    const roles = this.reflector.getAllAndOverride<readonly Role[] | undefined>(ROLES_KEY, targets);
    return Array.isArray(roles) && roles.length > 0;
  }
}
