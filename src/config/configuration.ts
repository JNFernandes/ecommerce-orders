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
  /** Whether the payment events consumer starts on bootstrap (`KAFKA_CONSUMER_ENABLED`, default true). */
  consumerEnabled: boolean;
  /** Attempts before a retryable failure is dead-lettered (`PAYMENT_CONSUMER_MAX_ATTEMPTS`, default 5). */
  maxAttempts: number;
  /** First retry delay in ms (`PAYMENT_CONSUMER_BACKOFF_INITIAL_MS`, default 1000). */
  backoffInitialMs: number;
  /** Maximum retry delay in ms (`PAYMENT_CONSUMER_BACKOFF_MAX_MS`, default 30000). */
  backoffMaxMs: number;
}

export interface AppConfig {
  port: number;
  database: DatabaseConfig;
  kafka: KafkaConfig;
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
    consumerEnabled: process.env.KAFKA_CONSUMER_ENABLED !== 'false',
    maxAttempts: parseInt(process.env.PAYMENT_CONSUMER_MAX_ATTEMPTS ?? '5', 10),
    backoffInitialMs: parseInt(process.env.PAYMENT_CONSUMER_BACKOFF_INITIAL_MS ?? '1000', 10),
    backoffMaxMs: parseInt(process.env.PAYMENT_CONSUMER_BACKOFF_MAX_MS ?? '30000', 10),
  },
});
