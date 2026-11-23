import { extractBearerToken } from '../../../../src/controllers/auth/bearer-token';

describe('extractBearerToken', () => {
  it('returns the token of a Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts the scheme in any case', () => {
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER abc')).toBe('abc');
  });

  it('returns null when the header is missing', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for another scheme', () => {
    expect(extractBearerToken('Basic x')).toBeNull();
  });

  it('returns null for Bearer with no token', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });

  it('returns null for extra parts or extra spaces', () => {
    expect(extractBearerToken('Bearer abc def')).toBeNull();
    expect(extractBearerToken('Bearer  abc')).toBeNull();
  });

  it('returns null for a repeated (array) header', () => {
    expect(extractBearerToken(['Bearer abc', 'Bearer def'])).toBeNull();
  });
});
