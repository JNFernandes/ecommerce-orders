import configuration, { parseOriginList } from '../../../src/config/configuration';

describe('parseOriginList', () => {
  it('returns no origins when the value is unset', () => {
    expect(parseOriginList(undefined)).toEqual([]);
  });

  it('returns no origins when the value is empty or only separators and spaces', () => {
    expect(parseOriginList('')).toEqual([]);
    expect(parseOriginList(' , ,')).toEqual([]);
  });

  it('splits on commas, trims whitespace and drops empty entries', () => {
    expect(parseOriginList(' https://a.example.com ,https://b.example.com,, ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });
});

describe('configuration: kafka', () => {
  const original = process.env.KAFKA_IDENTITY_GROUP_ID;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KAFKA_IDENTITY_GROUP_ID;
    } else {
      process.env.KAFKA_IDENTITY_GROUP_ID = original;
    }
  });

  it('uses the default identity consumer group when KAFKA_IDENTITY_GROUP_ID is unset', () => {
    delete process.env.KAFKA_IDENTITY_GROUP_ID;
    expect(configuration().kafka.identityGroupId).toBe('ecommerce-orders-identity-consumer');
  });

  it('reads the identity consumer group from KAFKA_IDENTITY_GROUP_ID', () => {
    process.env.KAFKA_IDENTITY_GROUP_ID = 'custom-identity-group';
    expect(configuration().kafka.identityGroupId).toBe('custom-identity-group');
  });
});

describe('configuration: cors', () => {
  const original = process.env.CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = original;
    }
  });

  it('allows no origins by default', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    expect(configuration().cors.allowedOrigins).toEqual([]);
  });

  it('reads the allowed origins from CORS_ALLOWED_ORIGINS', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://shop.example.com, http://localhost:5173';
    expect(configuration().cors.allowedOrigins).toEqual([
      'https://shop.example.com',
      'http://localhost:5173',
    ]);
  });
});

describe('configuration: auth', () => {
  const keys = [
    'IDENTITY_JWKS_URL',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'JWT_CLOCK_TOLERANCE_SECONDS',
  ] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    keys.forEach((key) => delete process.env[key]);
  });

  afterEach(() => {
    original.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it('uses the local Identity key set and a 5 s tolerance by default', () => {
    const { auth } = configuration();
    expect(auth.jwksUrl).toBe('http://localhost:3001/.well-known/jwks.json');
    expect(auth.clockToleranceSeconds).toBe(5);
  });

  it('leaves issuer and audience undefined when unset, without throwing', () => {
    const { auth } = configuration();
    expect(auth.issuer).toBeUndefined();
    expect(auth.audience).toBeUndefined();
  });

  it('reads every auth setting from the environment', () => {
    process.env.IDENTITY_JWKS_URL = 'http://identity:3001/.well-known/jwks.json';
    process.env.JWT_ISSUER = 'http://identity:3001';
    process.env.JWT_AUDIENCE = 'shop';
    process.env.JWT_CLOCK_TOLERANCE_SECONDS = '10';
    expect(configuration().auth).toEqual({
      jwksUrl: 'http://identity:3001/.well-known/jwks.json',
      issuer: 'http://identity:3001',
      audience: 'shop',
      clockToleranceSeconds: 10,
    });
  });
});
