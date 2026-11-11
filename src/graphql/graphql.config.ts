import { ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigService } from '@nestjs/config';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { GraphqlConfig } from '../config/configuration';

/**
 * Apollo options for the code-first GraphQL API at /graphql. The schema is generated in memory
 * (docs/schema.gql is produced by `npm run schema:generate`). Outside production, introspection
 * and the Apollo Sandbox landing page are on; in production both are off.
 */
export function buildGraphqlOptions(configService: ConfigService): ApolloDriverConfig {
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
    plugins: devTools ? [sandboxLandingPage()] : [],
  };
}

type ApolloPlugin = NonNullable<ApolloDriverConfig['plugins']>[number];

/**
 * The Apollo Sandbox landing page. `@apollo/server` ships both ESM and CJS type declarations and
 * different resolvers (tsc vs ts-jest) can pick different ones for this subpath and for
 * `@nestjs/apollo`'s own types; the plugin is the same object either way, so it is typed here as
 * the driver's plugin type.
 */
function sandboxLandingPage(): ApolloPlugin {
  return ApolloServerPluginLandingPageLocalDefault({ embed: true }) as ApolloPlugin;
}
