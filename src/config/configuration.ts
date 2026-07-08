export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  groupId: string;
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
  },
});
