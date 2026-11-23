import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  FlattenedJWSInput,
  JSONWebKeySet,
  JWKSCacheInput,
  jwksCache,
  JWSHeaderParameters,
  JWTPayload,
  jwtVerify,
  KeyLike,
} from 'jose';
import { validate as isUuid } from 'uuid';
import { AccessTokenClaims } from './access-token-claims';
import { AccessTokenError, AccessTokenErrorCategory } from './access-token.error';
import { parseRoles } from './role.enum';

/** Settings the verifier needs; built from the validated `auth` config by `AuthModule`. */
export interface AccessTokenVerifierConfig {
  /** URL of Identity's key set. */
  readonly jwksUrl: string;
  /** Expected `iss`. */
  readonly issuer: string;
  /** Expected `aud` (a token whose `aud` array contains it is accepted). */
  readonly audience: string;
  /** Allowed clock skew on `exp`, `nbf` and `iat`, in seconds. */
  readonly clockToleranceSeconds: number;
}

/** Minimum time between two key set fetches, in ms (research R2). */
const COOLDOWN_MS = 60_000;

/** Age after which a loaded key set is refreshed, in ms (research R3). */
const CACHE_MAX_AGE_MS = 300_000;

/**
 * Timing overrides for tests only, so they can exercise the cooldown and the refresh without
 * waiting minutes. Production code (`AuthModule`) passes none and gets the defaults.
 */
export interface AccessTokenVerifierTimings {
  /** Minimum time between two key set fetches, in ms. Default 60 000. */
  readonly cooldownMs?: number;
  /** Age after which a loaded key set is refreshed, in ms. Default 300 000. */
  readonly cacheMaxAgeMs?: number;
}

/** Wraps any failure to obtain the key set, so it is told apart from a bad token. */
class KeySetUnavailable extends Error {}

/** Resolves the key for a token header, as jose's `jwtVerify` expects. */
type KeyResolver = (header: JWSHeaderParameters, input: FlattenedJWSInput) => Promise<KeyLike>;

/** Whether the key set holds at least one key Orders can verify with (RSA, RS256, signing). */
function hasUsableKey(jwks: JSONWebKeySet): boolean {
  return jwks.keys.some(
    (key) =>
      key.kty === 'RSA' &&
      (key.alg === undefined || key.alg === 'RS256') &&
      (key.use === undefined || key.use === 'sig'),
  );
}

/** Whether jose rejected the token's `kid` (as opposed to failing to get the key set). */
function isKeyMismatch(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys
  );
}

/**
 * Verifies Identity access tokens locally (research R2–R7): RS256 only, a `kid` that is in
 * Identity's key set, the configured issuer and audience, `exp`/`nbf`/`iat` within the tolerance,
 * and the claim shapes Orders relies on. The key set is fetched lazily on the first verification
 * (never at startup), shared by concurrent callers, refreshed after 5 minutes and refetched at
 * most once a minute for an unknown `kid`. A failed fetch or refresh, a non-JSON answer or a set
 * with no usable RS256 key never discards the last good key set (research R4); only with no key
 * set ever loaded does verification fail with `KEYS_UNAVAILABLE`.
 */
export class AccessTokenVerifier {
  private readonly keys: KeyResolver;

  /** Filled by jose with the key set of the last successful fetch (and its time). */
  private readonly fetched: JWKSCacheInput = {};

  /** The last fetched key set that held a usable key: the fallback when a refresh fails. */
  private lastGood: JSONWebKeySet | undefined;

  /**
   * Builds the verifier. Makes no network call.
   *
   * @param timings Tests only; production passes none (see {@link AccessTokenVerifierTimings}).
   */
  constructor(
    private readonly config: AccessTokenVerifierConfig,
    timings: AccessTokenVerifierTimings = {},
  ) {
    const remote = createRemoteJWKSet(new URL(config.jwksUrl), {
      cooldownDuration: timings.cooldownMs ?? COOLDOWN_MS,
      cacheMaxAge: timings.cacheMaxAgeMs ?? CACHE_MAX_AGE_MS,
      [jwksCache]: this.fetched,
    });
    this.keys = async (header, input): Promise<KeyLike> => {
      try {
        const key = await remote(header, input);
        this.rememberFetched();
        return key;
      } catch (error) {
        const fetchedUsable = this.rememberFetched();
        if (isKeyMismatch(error) && fetchedUsable) {
          throw error;
        }
        // The fetch failed or returned nothing usable: fall back to the last good set, if any.
        if (this.lastGood === undefined) {
          throw new KeySetUnavailable();
        }
        return createLocalJWKSet(this.lastGood)(header, input);
      }
    };
  }

  /**
   * Keeps the key set jose last fetched as the fallback when it holds a usable key. Returns
   * whether it does (`false` also when nothing was fetched yet).
   */
  private rememberFetched(): boolean {
    const jwks = 'jwks' in this.fetched ? this.fetched.jwks : undefined;
    if (jwks === undefined || !hasUsableKey(jwks)) {
      return false;
    }
    this.lastGood = jwks;
    return true;
  }

  /**
   * Verifies a token and returns its frozen claims.
   *
   * @throws AccessTokenError `INVALID` for any bad token, `KEYS_UNAVAILABLE` when the key set
   *   cannot be fetched. The error never contains the token.
   */
  async verify(token: string): Promise<AccessTokenClaims> {
    let kid: unknown;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new AccessTokenError('INVALID', 'malformed');
    }
    // Without a kid jose would try the only key of a one-key set (R5): never try every key.
    if (typeof kid !== 'string' || kid.length === 0) {
      throw new AccessTokenError('INVALID', 'signature');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSeconds,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw toAccessTokenError(error);
    }
    return this.toClaims(payload);
  }

  /** Checks the claim shapes jose does not (research R6) and builds the frozen claims. */
  private toClaims(payload: JWTPayload): AccessTokenClaims {
    const { sub, iat } = payload;
    const roles: unknown = payload.roles;
    const customerId: unknown = payload.customerId;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const valid =
      typeof sub === 'string' &&
      sub.length > 0 &&
      typeof iat === 'number' &&
      iat <= nowSeconds + this.config.clockToleranceSeconds &&
      Array.isArray(roles) &&
      roles.every((role): role is string => typeof role === 'string') &&
      (customerId === undefined || (typeof customerId === 'string' && isUuid(customerId)));
    if (!valid) {
      throw new AccessTokenError('INVALID', 'claims');
    }
    return Object.freeze({
      sub,
      roles: Object.freeze([...parseRoles(roles)]),
      ...(customerId === undefined ? {} : { customerId }),
    });
  }
}

/** Maps a jose (or key set) failure to the one error the rest of Orders knows. */
function toAccessTokenError(error: unknown): AccessTokenError {
  if (error instanceof KeySetUnavailable) {
    return new AccessTokenError('KEYS_UNAVAILABLE', 'fetch');
  }
  return new AccessTokenError('INVALID', invalidCategory(error));
}

/** Why jose rejected a token, for the log line. */
function invalidCategory(error: unknown): AccessTokenErrorCategory {
  if (error instanceof errors.JWTExpired) {
    return 'expired';
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') {
      return 'issuer';
    }
    return error.claim === 'aud' ? 'audience' : 'claims';
  }
  if (error instanceof errors.JOSEAlgNotAllowed) {
    return 'algorithm';
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return 'signature';
  }
  if (isKeyMismatch(error)) {
    return 'unknown-kid';
  }
  return 'malformed';
}
