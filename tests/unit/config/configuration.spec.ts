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
