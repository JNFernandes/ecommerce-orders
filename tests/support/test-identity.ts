import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  calculateJwkThumbprint,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  JWK,
  JWTPayload,
  KeyLike,
  SignJWT,
} from 'jose';

/** Path the fake Identity serves its key set on (same as ecommerce-identity). */
const JWKS_PATH = '/.well-known/jwks.json';

/** Default token lifetime, in seconds (Identity's access tokens live 15 minutes). */
const DEFAULT_TTL_SECONDS = 15 * 60;

/** One signing key held by the fake Identity. */
interface SigningKey {
  readonly kid: string;
  readonly publicJwk: JWK;
  readonly publicKey: KeyLike;
  readonly privateKey: KeyLike;
}

/**
 * Claims a test token can carry. Known Identity claims are typed; anything else is allowed so
 * negative tests can send odd shapes. A claim set to `undefined` is left out of the token.
 */
export interface TestTokenClaims {
  sub?: string;
  customerId?: unknown;
  roles?: unknown;
  [claim: string]: unknown;
}

/** Protected header overrides. `kid: null` removes the key id from the header. */
export interface TestTokenHeader {
  alg?: string;
  kid?: string | null;
  [parameter: string]: unknown;
}

/** Options for {@link TestIdentity.sign}. Times are seconds since the epoch. */
export interface TestSignOptions {
  /** Header overrides, e.g. another `kid` or no `kid` at all. */
  header?: TestTokenHeader;
  /** Signing key; defaults to the current RS256 private key. */
  key?: KeyLike | Uint8Array;
  /** Lifetime in seconds from `iat` (negative: already expired). Default 15 minutes. */
  expiresIn?: number;
  /** Issued-at time. Default now. */
  iat?: number;
  /** Not-before time. Default absent. */
  nbf?: number;
  /** `iss` claim. Default {@link TestIdentity.issuer}. */
  issuer?: string;
  /** `aud` claim. Default {@link TestIdentity.audience}. */
  audience?: string | string[];
}

/** Current time in whole seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Base64url-encodes a JSON value (for hand-built tokens). */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Generates an RS256 key pair with its public JWK and thumbprint `kid`. */
async function createSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return {
    kid,
    publicKey,
    privateKey,
    publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
  };
}

/**
 * A fake ecommerce-identity for tests (research R15): holds RS256 keys, serves them as a JWKS
 * over a local HTTP server and mints access tokens, so no running Identity is needed. Supports
 * key rotation, key removal, outages and counting key set requests.
 */
export class TestIdentity {
  /** Issuer every token carries by default. */
  readonly issuer = 'http://test-identity';

  /** Audience every token carries by default. */
  readonly audience = 'ecommerce';

  private keys: SigningKey[];
  private current: SigningKey;
  private available = true;
  private requests = 0;

  private constructor(
    private readonly server: Server,
    firstKey: SigningKey,
  ) {
    this.keys = [firstKey];
    this.current = firstKey;
  }

  /** Generates a key pair and starts the key set server on a free local port. */
  static async start(): Promise<TestIdentity> {
    const key = await createSigningKey();
    const server = createServer();
    const identity = new TestIdentity(server, key);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => identity.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return identity;
  }

  /** URL of the served key set. */
  get jwksUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${JWKS_PATH}`;
  }

  /** Number of key set requests received so far (including failed ones). */
  get requestCount(): number {
    return this.requests;
  }

  /** Key id of the current signing key. */
  get currentKid(): string {
    return this.current.kid;
  }

  /** The current public key as PEM (for "HS256 signed with the public key" attacks). */
  publicKeyPem(): Promise<string> {
    return exportSPKI(this.current.publicKey);
  }

  /**
   * Signs a token with the current key (or `options.key`). Defaults: random UUID `sub`, no
   * roles, `iat` now, `exp` 15 minutes later, the test issuer and audience.
   */
  async sign(claims: TestTokenClaims = {}, options: TestSignOptions = {}): Promise<string> {
    const iat = options.iat ?? nowSeconds();
    const payload: JWTPayload = {
      iss: options.issuer ?? this.issuer,
      aud: options.audience ?? this.audience,
      sub: randomUUID(),
      roles: [],
      iat,
      exp: iat + (options.expiresIn ?? DEFAULT_TTL_SECONDS),
      ...(options.nbf === undefined ? {} : { nbf: options.nbf }),
      ...claims,
    };
    const { kid, ...headerRest } = options.header ?? {};
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      ...(kid === null ? {} : { kid: kid ?? this.current.kid }),
      ...headerRest,
    };
    return new SignJWT(payload)
      .setProtectedHeader(header)
      .sign(options.key ?? this.current.privateKey);
  }

  /** A token for a customer user: `roles: ['CUSTOMER']` and the given `customerId`. */
  customerToken(customerId: string): Promise<string> {
    return this.sign({ roles: ['CUSTOMER'], customerId });
  }

  /** A token for an admin user with no `customerId`. */
  adminToken(): Promise<string> {
    return this.sign({ roles: ['ADMIN'] });
  }

  /** A token holding both roles and the given `customerId`. */
  customerAdminToken(customerId: string): Promise<string> {
    return this.sign({ roles: ['CUSTOMER', 'ADMIN'], customerId });
  }

  /**
   * An HS256 token signed with `secret` (any string, e.g. the public key PEM), carrying the
   * current `kid` and valid `iss`/`aud`/`exp` so only the algorithm is wrong.
   */
  signHs256(secret: string, claims: TestTokenClaims = {}): Promise<string> {
    return this.sign(claims, {
      header: { alg: 'HS256' },
      key: new TextEncoder().encode(secret),
    });
  }

  /** An unsigned token (`alg: none`) with otherwise valid claims and the current `kid`. */
  unsignedToken(claims: TestTokenClaims = {}): string {
    const iat = nowSeconds();
    const header = { alg: 'none', typ: 'JWT', kid: this.current.kid };
    const payload = {
      iss: this.issuer,
      aud: this.audience,
      sub: randomUUID(),
      roles: [],
      iat,
      exp: iat + DEFAULT_TTL_SECONDS,
      ...claims,
    };
    return `${encodeSegment(header)}.${encodeSegment(payload)}.`;
  }

  /**
   * Adds a new key pair and makes it the signing key. The served set holds the old and the new
   * key. Returns the new `kid`.
   */
  async rotate(): Promise<string> {
    const key = await createSigningKey();
    this.keys = [...this.keys, key];
    this.current = key;
    return key.kid;
  }

  /** Stops serving the key with this `kid` (tokens it signed can still be minted). */
  removeKey(kid: string): void {
    this.keys = this.keys.filter((key) => key.kid !== kid);
  }

  /** `false` makes the key set endpoint answer HTTP 500, simulating an Identity outage. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Points Orders at this fake Identity through its four auth environment variables. */
  applyEnv(): void {
    process.env.IDENTITY_JWKS_URL = this.jwksUrl;
    process.env.JWT_ISSUER = this.issuer;
    process.env.JWT_AUDIENCE = this.audience;
    process.env.JWT_CLOCK_TOLERANCE_SECONDS = '5';
  }

  /** Stops the key set server. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url !== JWKS_PATH) {
      res.writeHead(404).end();
      return;
    }
    this.requests += 1;
    if (!this.available) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('unavailable');
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ keys: this.keys.map((key) => key.publicJwk) }));
  }
}
