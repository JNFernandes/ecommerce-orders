import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuthConfig } from '../../config/configuration';
import { AuthExceptionFilter } from '../../controllers/auth/auth-exception.filter';
import { JwtAuthGuard } from '../../controllers/auth/jwt-auth.guard';
import { RolesGuard } from '../../controllers/auth/roles.guard';
import { RoutePolicyValidator } from '../../controllers/auth/route-policy.validator';
import { AccessTokenVerifier } from './access-token.verifier';

/**
 * Builds the token verifier from the `auth` config. Throws when `JWT_ISSUER` or `JWT_AUDIENCE` is
 * missing, so the service refuses to start (research R14). Makes no network call.
 */
export function createAccessTokenVerifier(configService: ConfigService): AccessTokenVerifier {
  const auth = configService.get<AuthConfig>('auth');
  if (auth?.issuer === undefined || auth.issuer === '') {
    throw new Error('JWT_ISSUER is required');
  }
  if (auth.audience === undefined || auth.audience === '') {
    throw new Error('JWT_AUDIENCE is required');
  }
  return new AccessTokenVerifier({
    jwksUrl: auth.jwksUrl,
    issuer: auth.issuer,
    audience: auth.audience,
    clockToleranceSeconds: auth.clockToleranceSeconds,
  });
}

/**
 * Access control for every route: the global guards (`JwtAuthGuard` then `RolesGuard`,
 * registration order is execution order, research R8), the filter that answers token failures
 * and the startup check that every route and resolver has an access rule (research R13).
 * Needs a global `ConfigModule` with the `auth` section.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    {
      provide: AccessTokenVerifier,
      inject: [ConfigService],
      useFactory: createAccessTokenVerifier,
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AuthExceptionFilter },
    RoutePolicyValidator,
  ],
  exports: [AccessTokenVerifier],
})
export class AuthModule {}
