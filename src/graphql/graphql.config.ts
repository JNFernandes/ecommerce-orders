import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { GraphqlConfig } from '../config/configuration';
import { AccessTokenVerifier } from '../infra/auth/access-token.verifier';
import { AuthModule } from '../infra/auth/auth.module';
import { graphqlAuthPlugin } from './graphql-auth.plugin';
import { buildGraphqlContext } from './graphql-context';

/**
 * Apollo options for the code-first GraphQL API at /graphql. The schema is generated in memory
 * (docs/schema.gql is produced by `npm run schema:generate`). Every request's token is verified
 * in the context and every operation of a caller without one is rejected by the auth plugin
 * (US-11). Outside production, introspection (still behind a token) and the Apollo Sandbox
 * landing page are on; in production both are off. Makes no network call.
 */
export function buildGraphqlOptions(
  configService: ConfigService,
  verifier: AccessTokenVerifier,
): ApolloDriverConfig {
  const devTools = configService.get<GraphqlConfig>('graphql')?.devTools ?? false;
  return {
    path: '/graphql',
    autoSchemaFile: true,
    sortSchema: true,
    introspection: devTools,
    // `playground: false` stops @nestjs/apollo installing the deprecated GraphQL Playground and
    // adds Apollo's "landing page disabled" marker; the Sandbox plugin below is the only landing
    // page outside production.
    playground: false,
    context: buildGraphqlContext(verifier),
    plugins: devTools ? [authPlugin(), sandboxLandingPage()] : [authPlugin()],
  };
}

/**
 * The `GraphQLModule` of the app: Apollo with {@link buildGraphqlOptions}, the verifier from
 * `AuthModule` (which also registers the global guards). Needs a global `ConfigModule`.
 */
export function graphqlModule(): DynamicModule {
  return GraphQLModule.forRootAsync<ApolloDriverConfig>({
    driver: ApolloDriver,
    imports: [AuthModule],
    inject: [ConfigService, AccessTokenVerifier],
    useFactory: buildGraphqlOptions,
  });
}

type ApolloPlugin = NonNullable<ApolloDriverConfig['plugins']>[number];

/** The auth plugin, typed as the driver's plugin type (see {@link sandboxLandingPage}). */
function authPlugin(): ApolloPlugin {
  return graphqlAuthPlugin as ApolloPlugin;
}

/**
 * The Apollo Sandbox landing page. `@apollo/server` ships both ESM and CJS type declarations and
 * different resolvers (tsc vs ts-jest) can pick different ones for this subpath and for
 * `@nestjs/apollo`'s own types; the plugin is the same object either way, so it is typed here as
 * the driver's plugin type.
 */
function sandboxLandingPage(): ApolloPlugin {
  return ApolloServerPluginLandingPageLocalDefault({ embed: true }) as ApolloPlugin;
}
