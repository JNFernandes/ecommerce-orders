/**
 * `INVALID`: the caller sent no usable token (REST 401, GraphQL `UNAUTHENTICATED`).
 * `KEYS_UNAVAILABLE`: no Identity keys were ever loaded and they cannot be fetched now
 * (REST 503, GraphQL `SERVICE_UNAVAILABLE`).
 */
export type AccessTokenErrorKind = 'INVALID' | 'KEYS_UNAVAILABLE';

/** Why a token was rejected. For log lines only; never sent to the caller. */
export type AccessTokenErrorCategory =
  | 'missing'
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'unknown-kid'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'claims'
  | 'fetch';

const MESSAGES: Readonly<Record<AccessTokenErrorKind, string>> = {
  INVALID: 'Access token rejected',
  KEYS_UNAVAILABLE: 'Identity signing keys are unavailable',
};

/**
 * The single error the token verifier and the auth guard throw (research R7). Its message is
 * fixed per kind and never contains the token or any part of it.
 */
export class AccessTokenError extends Error {
  /**
   * @param kind Which answer the caller gets (401 or 503).
   * @param category Why, for the log line.
   */
  constructor(
    readonly kind: AccessTokenErrorKind,
    readonly category: AccessTokenErrorCategory,
  ) {
    super(MESSAGES[kind]);
    this.name = 'AccessTokenError';
  }
}
