export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /**
   * Apply pending TypeORM migrations when the app starts, before it serves requests
   * (`DB_MIGRATIONS_RUN`, on unless "false").
   */
  migrationsRun: boolean;
}

export interface KafkaConfig {
  /** Broker addresses (`KAFKA_BROKERS`, comma-separated). */
  brokers: string[];
  /** Kafka client id (`KAFKA_CLIENT_ID`). */
  clientId: string;
  /** Consumer group id used by the payment events consumer (`KAFKA_GROUP_ID`). */
  groupId: string;
  /**
   * Consumer group id used by the order read-model projection (`KAFKA_PROJECTION_GROUP_ID`,
   * default `ecommerce-orders-projection`). Separate from `groupId`.
   */
  projectionGroupId: string;
  /**
   * Consumer group id used by the inventory (stock outcome) events consumer
   * (`KAFKA_INVENTORY_GROUP_ID`, default `ecommerce-orders-inventory-consumer`). Separate from
   * `groupId`: two kafkajs consumers with different subscriptions must not share a group.
   */
  inventoryGroupId: string;
  /**
   * Consumer group id used by the identity (user registered) events consumer
   * (`KAFKA_IDENTITY_GROUP_ID`, default `ecommerce-orders-identity-consumer`). Separate from the
   * other groups: two kafkajs consumers with different subscriptions must not share a group.
   */
  identityGroupId: string;
  /**
   * Whether the Kafka consumers (payment, inventory and identity events, and read-model projection)
   * start on bootstrap (`KAFKA_CONSUMER_ENABLED`, default true).
   */
  consumerEnabled: boolean;
  /**
   * Attempts before a retryable failure is dead-lettered, for every consumer
   * (`PAYMENT_CONSUMER_MAX_ATTEMPTS`, default 5; name kept for compatibility).
   */
  maxAttempts: number;
  /** First retry delay in ms, for every consumer (`PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, default 1000). */
  backoffInitialMs: number;
  /** Maximum retry delay in ms, for every consumer (`PAYMENT_CONSUMER_BACKOFF_MAX_MS`, default 30000). */
  backoffMaxMs: number;
  /**
   * Timeout in ms for opening a broker connection (`KAFKA_CONNECTION_TIMEOUT_MS`, default 1000).
   * With `producerRetries`, it bounds how long a publish to an unreachable broker can take.
   */
  connectionTimeoutMs: number;
  /**
   * Retries for connecting and publishing before the producer gives up and the event is
   * dead-lettered (`KAFKA_PRODUCER_RETRIES`, default 1). Consumers keep kafkajs's default of 5
   * for processing, and reconnect on their own loop.
   */
  producerRetries: number;
}

export interface ReadModelConfig {
  /** MongoDB connection string for the read model (`MONGO_URI`). */
  mongoUri: string;
}

export interface GraphqlConfig {
  /**
   * Introspection and the Apollo Sandbox landing page at /graphql. On unless
   * `NODE_ENV=production`.
   */
  devTools: boolean;
}

export interface DeadLetterConfig {
  /** Whether the dead-letter retry worker runs (`DEAD_LETTER_RETRY_ENABLED`, on unless "false"). */
  enabled: boolean;
  /** Pause between retry cycles in ms (`DEAD_LETTER_RETRY_INTERVAL_MS`, default 30000). */
  intervalMs: number;
  /** Max rows retried per store per cycle (`DEAD_LETTER_BATCH_SIZE`, default 20). */
  batchSize: number;
  /** First backoff delay in ms (`DEAD_LETTER_BASE_DELAY_MS`, default 5000). */
  baseDelayMs: number;
  /** Backoff cap in ms (`DEAD_LETTER_MAX_DELAY_MS`, default 600000). */
  maxDelayMs: number;
  /** Failed worker attempts before a row is EXHAUSTED (`DEAD_LETTER_MAX_RETRIES`, default 8). */
  maxRetries: number;
}

export interface CorsConfig {
  /**
   * Origins allowed to call the REST API and /graphql from a browser (`CORS_ALLOWED_ORIGINS`,
   * comma-separated, matched exactly, e.g. `https://shop.example.com`). Empty or unset: no
   * cross-origin access.
   */
  allowedOrigins: string[];
}

export interface AuthConfig {
  /**
   * URL of Identity's public key set (`IDENTITY_JWKS_URL`, default
   * `http://localhost:3001/.well-known/jwks.json`). Fetched lazily on the first request, never at
   * startup.
   */
  jwksUrl: string;
  /**
   * Expected `iss` claim (`JWT_ISSUER`). No default: the auth module refuses to start without it,
   * so `configuration()` itself never throws.
   */
  issuer: string | undefined;
  /** Expected `aud` claim (`JWT_AUDIENCE`). No default, required by the auth module. */
  audience: string | undefined;
  /** Clock skew allowed on `exp`, `nbf` and `iat`, in seconds (`JWT_CLOCK_TOLERANCE_SECONDS`, default 5). */
  clockToleranceSeconds: number;
}

export interface AppConfig {
  port: number;
  cors: CorsConfig;
  database: DatabaseConfig;
  kafka: KafkaConfig;
  readModel: ReadModelConfig;
  graphql: GraphqlConfig;
  deadLetter: DeadLetterConfig;
  auth: AuthConfig;
}

/**
 * Splits a comma-separated origin list, trimming whitespace and dropping empty entries, so an
 * empty or unset value yields no origins.
 */
export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  cors: {
    allowedOrigins: parseOriginList(process.env.CORS_ALLOWED_ORIGINS),
  },
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'orders',
    password: process.env.DB_PASSWORD ?? 'orders',
    database: process.env.DB_NAME ?? 'orders',
    migrationsRun: process.env.DB_MIGRATIONS_RUN !== 'false',
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID ?? 'ecommerce-orders',
    groupId: process.env.KAFKA_GROUP_ID ?? 'ecommerce-orders-consumer',
    projectionGroupId: process.env.KAFKA_PROJECTION_GROUP_ID ?? 'ecommerce-orders-projection',
    inventoryGroupId: process.env.KAFKA_INVENTORY_GROUP_ID ?? 'ecommerce-orders-inventory-consumer',
    identityGroupId: process.env.KAFKA_IDENTITY_GROUP_ID ?? 'ecommerce-orders-identity-consumer',
    consumerEnabled: process.env.KAFKA_CONSUMER_ENABLED !== 'false',
    maxAttempts: parseInt(process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS ?? '5', 10),
    backoffInitialMs: parseInt(process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS ?? '1000', 10),
    backoffMaxMs: parseInt(process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS ?? '30000', 10),
    connectionTimeoutMs: parseInt(process.env.KAFKA_CONNECTION_TIMEOUT_MS ?? '1000', 10),
    producerRetries: parseInt(process.env.KAFKA_PRODUCER_RETRIES ?? '1', 10),
  },
  readModel: {
    mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/orders_read',
  },
  graphql: {
    devTools: process.env.NODE_ENV !== 'production',
  },
  deadLetter: {
    enabled: process.env.DEAD_LETTER_RETRY_ENABLED !== 'false',
    intervalMs: parseInt(process.env.DEAD_LETTER_RETRY_INTERVAL_MS ?? '30000', 10),
    batchSize: parseInt(process.env.DEAD_LETTER_BATCH_SIZE ?? '20', 10),
    baseDelayMs: parseInt(process.env.DEAD_LETTER_BASE_DELAY_MS ?? '5000', 10),
    maxDelayMs: parseInt(process.env.DEAD_LETTER_MAX_DELAY_MS ?? '600000', 10),
    maxRetries: parseInt(process.env.DEAD_LETTER_MAX_RETRIES ?? '8', 10),
  },
  auth: {
    jwksUrl: process.env.IDENTITY_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json',
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    clockToleranceSeconds: parseInt(process.env.JWT_CLOCK_TOLERANCE_SECONDS ?? '5', 10),
  },
});
