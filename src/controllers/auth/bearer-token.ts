/**
 * Reads the token from an `Authorization` header value: the `Bearer` scheme (any case) followed
 * by exactly one space and one token. Anything else, including a repeated header, gives `null`.
 */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const parts = header.split(' ');
  if (parts.length !== 2) {
    return null;
  }
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) {
    return null;
  }
  return token;
}
