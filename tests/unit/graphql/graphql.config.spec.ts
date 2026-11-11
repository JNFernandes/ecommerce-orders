import { ConfigService } from '@nestjs/config';
import { buildGraphqlOptions } from '../../../src/graphql/graphql.config';

function config(graphql: { devTools: boolean } | undefined): ConfigService {
  return { get: jest.fn().mockReturnValue(graphql) } as unknown as ConfigService;
}

describe('buildGraphqlOptions', () => {
  it('should serve /graphql from an in-memory, sorted schema without the deprecated playground', () => {
    const options = buildGraphqlOptions(config({ devTools: true }));

    expect(options).toMatchObject({
      path: '/graphql',
      autoSchemaFile: true,
      sortSchema: true,
      playground: false,
    });
  });

  it('should enable introspection and the Apollo Sandbox outside production', () => {
    const options = buildGraphqlOptions(config({ devTools: true }));

    expect(options.introspection).toBe(true);
    expect(options.plugins).toHaveLength(1);
  });

  it('should disable introspection and every landing page in production', () => {
    const options = buildGraphqlOptions(config({ devTools: false }));

    expect(options.introspection).toBe(false);
    expect(options.plugins).toEqual([]);
  });

  it('should default to the production behaviour when the graphql config is missing', () => {
    const options = buildGraphqlOptions(config(undefined));

    expect(options.introspection).toBe(false);
    expect(options.plugins).toEqual([]);
  });
});
