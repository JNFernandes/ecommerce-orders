export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
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
   * Whether the Kafka consumers (payment events and read-model projection) start on bootstrap
   * (`KAFKA_CONSUMER_ENABLED`, default true).
   */
  consumerEnabled: boolean;
  /**
   * Attempts before a retryable failure is dead-lettered, for both consumers
   * (`PAYMENT_CONSUMER_MAX_ATTEMPTS`, default 5; name kept for compatibility).
   */
  maxAttempts: number;
  /** First retry delay in ms, for both consumers (`PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, default 1000). */
  backoffInitialMs: number;
  /** Maximum retry delay in ms, for both consumers (`PAYMENT_CONSUMER_BACKOFF_MAX_MS`, default 30000). */
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

export interface AppConfig {
  port: number;
  database: DatabaseConfig;
  kafka: KafkaConfig;
  readModel: ReadModelConfig;
  graphql: GraphqlConfig;
  deadLetter: DeadLetterConfig;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'orders',
    password: process.env.DB_PASSWORD ?? 'orders',
    database: process.env.DB_NAME ?? 'orders',
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID ?? 'ecommerce-orders',
    groupId: process.env.KAFKA_GROUP_ID ?? 'ecommerce-orders-consumer',
    projectionGroupId: process.env.KAFKA_PROJECTION_GROUP_ID ?? 'ecommerce-orders-projection',
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
});
