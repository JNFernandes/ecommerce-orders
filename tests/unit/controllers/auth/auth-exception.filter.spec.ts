import { ArgumentsHost, Logger } from '@nestjs/common';
import { AuthExceptionFilter } from '../../../../src/controllers/auth/auth-exception.filter';
import {
  AccessTokenError,
  AccessTokenErrorCategory,
} from '../../../../src/infra/auth/access-token.error';

interface CapturedResponse {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

function httpHost(captured: CapturedResponse): ArgumentsHost {
  interface FakeResponse {
    status(code: number): FakeResponse;
    setHeader(name: string, value: string): FakeResponse;
    json(body: unknown): FakeResponse;
  }
  const response: FakeResponse = {
    status(code: number): FakeResponse {
      captured.status = code;
      return response;
    },
    setHeader(name: string, value: string): FakeResponse {
      captured.headers[name] = value;
      return response;
    },
    json(body: unknown): FakeResponse {
      captured.body = body;
      return response;
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

const INVALID_CATEGORIES: AccessTokenErrorCategory[] = [
  'missing',
  'malformed',
  'algorithm',
  'signature',
  'unknown-kid',
  'issuer',
  'audience',
  'expired',
  'claims',
];

describe('AuthExceptionFilter', () => {
  const filter = new AuthExceptionFilter();
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each(INVALID_CATEGORIES)('answers INVALID/%s with the same 401', (category) => {
    const captured: CapturedResponse = { headers: {} };
    filter.catch(new AccessTokenError('INVALID', category), httpHost(captured));
    expect(captured.status).toBe(401);
    expect(captured.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    expect(JSON.stringify(captured.body)).toBe('{"statusCode":401,"message":"Unauthorized"}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`Rejected request: ${category}`);
  });

  it('answers KEYS_UNAVAILABLE with the fixed 503', () => {
    const captured: CapturedResponse = { headers: {} };
    filter.catch(new AccessTokenError('KEYS_UNAVAILABLE', 'fetch'), httpHost(captured));
    expect(captured.status).toBe(503);
    expect(captured.headers).toEqual({});
    expect(JSON.stringify(captured.body)).toBe(
      '{"statusCode":503,"message":"Service Unavailable"}',
    );
    expect(warn).toHaveBeenCalledWith('Rejected request: fetch');
  });

  it('rethrows for non-HTTP transports', () => {
    const error = new AccessTokenError('INVALID', 'missing');
    const host = { getType: () => 'graphql' } as unknown as ArgumentsHost;
    expect(() => filter.catch(error, host)).toThrow(error);
  });
});
