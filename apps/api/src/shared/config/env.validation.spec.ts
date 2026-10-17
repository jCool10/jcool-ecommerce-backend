import 'reflect-metadata'; // class-validator decorators; the app gets it from @nestjs/core's bootstrap.
import { describe, expect, it } from 'vitest';
import { NodeEnv } from '@jcool/platform/config';
import { validate } from './env.validation';

// The minimum a boot needs to get past every other required var, so each case below isolates one.
const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_JWKS_URL: 'http://user-service.railway.internal:3000/.well-known/jwks.json',
  JWT_ISSUER: 'https://api.jcool.test',
  JWT_AUDIENCE: 'jcool',
  USER_SERVICE_INTERNAL_URL: 'http://user-service.railway.internal:3000',
  INTERNAL_API_TOKEN: 'internal-api-token-not-a-real-secret-0000',
  ID_SERVICE_URL: 'http://gateway.railway.internal:4000',
  // The worker is on by default and consumes Kafka too.
  KAFKA_BROKERS: 'kafka.railway.internal:9092',
  MESSAGING_SIGNING_KEY: 'messaging-signing-key-not-a-real-secret-0000',
};

const WITHOUT_KAFKA = (({ KAFKA_BROKERS: _b, MESSAGING_SIGNING_KEY: _k, ...rest }) => rest)(BASE_ENV);

describe('env validation', () => {
  it('refuses to boot in production until TRUST_PROXY is set to anything', () => {
    const production = { ...BASE_ENV, NODE_ENV: NodeEnv.Production };

    expect(() => validate(production)).toThrow(/TRUST_PROXY/);
    for (const value of ['fd12::/16', '1', 'false']) {
      expect(() => validate({ ...production, TRUST_PROXY: value }), value).not.toThrow();
    }
  });

  it('leaves TRUST_PROXY optional outside production', () => {
    expect(() => validate(BASE_ENV)).not.toThrow();
  });

  // Without any one of these the api boots and then refuses every caller.
  it('refuses to boot without a setting the user-service link needs', () => {
    const required = ['AUTH_JWKS_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'USER_SERVICE_INTERNAL_URL', 'INTERNAL_API_TOKEN'];
    for (const key of required) {
      const without: Record<string, unknown> = { ...BASE_ENV };
      delete without[key];

      expect(() => validate(without), key).toThrow(new RegExp(key));
    }
  });

  it('refuses to boot without an http id-service address', () => {
    const { ID_SERVICE_URL: _, ...without } = BASE_ENV;

    expect(() => validate(without)).toThrow(/ID_SERVICE_URL/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_URL: 'gateway:4000' })).toThrow(/ID_SERVICE_URL/);
  });

  it('bounds the id-service timeout', () => {
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '99' })).toThrow(/ID_SERVICE_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '2e3' })).toThrow(/ID_SERVICE_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, ID_SERVICE_TIMEOUT_MS: '2000' })).not.toThrow();
  });

  it('refuses a short internal token', () => {
    expect(() => validate({ ...BASE_ENV, INTERNAL_API_TOKEN: 'a'.repeat(31) })).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('refuses a user-service or JWKS address that is not an http URL', () => {
    expect(() => validate({ ...BASE_ENV, USER_SERVICE_INTERNAL_URL: 'user-service:3000' })).toThrow(
      /USER_SERVICE_INTERNAL_URL/,
    );
    expect(() => validate({ ...BASE_ENV, AUTH_JWKS_URL: 'jwks.json' })).toThrow(/AUTH_JWKS_URL/);
  });

  it('caps the order.paid retry budget', () => {
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '31' })).toThrow(/ORDER_PAID_CONSUMER_ATTEMPTS/);
    expect(() => validate({ ...BASE_ENV, ORDER_PAID_CONSUMER_ATTEMPTS: '15' })).not.toThrow();
  });

  it('bounds the consumer retry poller', () => {
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_POLL_MS: '99' })).toThrow(/MESSAGING_RETRY_POLL_MS/);
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_BATCH_SIZE: '0' })).toThrow(/MESSAGING_RETRY_BATCH_SIZE/);
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_BATCH_SIZE: '501' })).toThrow(/MESSAGING_RETRY_BATCH_SIZE/);
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_ENABLED: '0' })).toThrow(/MESSAGING_RETRY_ENABLED/);
    expect(() =>
      validate({
        ...BASE_ENV,
        MESSAGING_RETRY_ENABLED: 'false',
        MESSAGING_RETRY_POLL_MS: '100',
        MESSAGING_RETRY_BATCH_SIZE: '500',
      }),
    ).not.toThrow();
  });

  // A lease that runs out mid-handler hands the same attempt to a second poller.
  it('refuses a retry lease shorter than the longest a handler or a shutdown may take', () => {
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_LEASE_MS: '29999' })).toThrow(/MESSAGING_RETRY_LEASE_MS/);
    expect(() => validate({ ...BASE_ENV, MESSAGING_RETRY_LEASE_MS: '30000' })).not.toThrow();
  });

  it('boots without a Kafka broker while nothing publishes or consumes through it', () => {
    const idle = { ...WITHOUT_KAFKA, QUEUE_WORKER_ENABLED: 'false', MESSAGING_TRANSPORT: 'bullmq' };

    expect(() => validate(idle)).not.toThrow();
    expect(() => validate({ ...idle, KAFKA_BROKERS: 'kafka:9092,127.0.0.1:9094' })).not.toThrow();
    expect(() => validate({ ...idle, KAFKA_BROKERS: '' })).toThrow(/KAFKA_BROKERS/);
  });

  it('refuses a transport other than bullmq or kafka', () => {
    expect(() => validate({ ...BASE_ENV, MESSAGING_TRANSPORT: 'rabbitmq' })).toThrow(/MESSAGING_TRANSPORT/);
    for (const transport of ['bullmq', 'kafka']) {
      expect(() => validate({ ...BASE_ENV, MESSAGING_TRANSPORT: transport }), transport).not.toThrow();
    }
  });

  // The worker runs the Kafka consumers whichever transport publishes.
  it('requires the broker and the signing key whenever the worker consumes or the relay publishes to Kafka', () => {
    const inUse = [
      { MESSAGING_TRANSPORT: 'kafka', QUEUE_WORKER_ENABLED: 'false' },
      { MESSAGING_TRANSPORT: 'bullmq', QUEUE_WORKER_ENABLED: 'true' },
      { MESSAGING_TRANSPORT: 'bullmq' },
      {},
    ];
    for (const flags of inUse) {
      const label = JSON.stringify(flags);
      const { KAFKA_BROKERS: _, ...noBroker } = BASE_ENV;
      const { MESSAGING_SIGNING_KEY: __, ...noKey } = BASE_ENV;

      expect(() => validate({ ...noBroker, ...flags }), label).toThrow(/KAFKA_BROKERS/);
      expect(() => validate({ ...noKey, ...flags }), label).toThrow(/MESSAGING_SIGNING_KEY/);
      expect(() => validate({ ...BASE_ENV, ...flags }), label).not.toThrow();
    }
  });

  it('refuses a signing key shorter than 32 characters and never echoes it', () => {
    const short = 'short-signing-key-0123456789abc';

    expect(() => validate({ ...BASE_ENV, MESSAGING_SIGNING_KEY: short })).toThrow(/MESSAGING_SIGNING_KEY/);
    expect(() => validate({ ...BASE_ENV, MESSAGING_SIGNING_KEY: short })).not.toThrow(new RegExp(short));
    expect(() => validate({ ...BASE_ENV, MESSAGING_SIGNING_KEY: 'k'.repeat(32) })).not.toThrow();
  });

  // The prefix lands in topic and group names, which Kafka limits to these characters.
  it('refuses a Kafka prefix Kafka would not accept in a topic name', () => {
    for (const prefix of ['', 'has space', 'a/b', 'jcool:prod', 'x'.repeat(101)]) {
      expect(() => validate({ ...BASE_ENV, KAFKA_PREFIX: prefix }), prefix).toThrow(/KAFKA_PREFIX/);
    }
    expect(() => validate({ ...BASE_ENV, KAFKA_PREFIX: 'e2e.kafka-client_behaviour' })).not.toThrow();
  });

  // The relay publishes while it holds the outbox row locks, so this also bounds how long they are held.
  it('bounds the Kafka delivery timeout', () => {
    expect(() => validate({ ...BASE_ENV, KAFKA_DELIVERY_TIMEOUT_MS: '999' })).toThrow(/KAFKA_DELIVERY_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, KAFKA_DELIVERY_TIMEOUT_MS: '30001' })).toThrow(/KAFKA_DELIVERY_TIMEOUT_MS/);
    expect(() => validate({ ...BASE_ENV, KAFKA_DELIVERY_TIMEOUT_MS: '1000' })).not.toThrow();
    expect(() => validate({ ...BASE_ENV, KAFKA_DELIVERY_TIMEOUT_MS: '30000' })).not.toThrow();
  });

  // The platform injects its own variables, and a retired key can linger in a deployment.
  it('boots with env keys the schema does not declare', () => {
    expect(() => validate({ ...BASE_ENV, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'not-a-number' })).not.toThrow();
  });

  // `parseIntOr` in configuration.ts reads with `parseInt`, which stops at the first non-digit:
  // '6e4' would load as 6ms, not 60000ms. Validation must refuse the value a loader would misread
  // rather than accept it and drift.
  it('refuses scientific-notation and hex integers that a loader would parse differently', () => {
    expect(() => validate({ ...BASE_ENV, RECONCILE_INTERVAL_MS: '6e4' })).toThrow(/RECONCILE_INTERVAL_MS/);
    expect(() => validate({ ...BASE_ENV, QUEUE_CONSUMER_BACKOFF_MS: '1e3' })).toThrow(/QUEUE_CONSUMER_BACKOFF_MS/);
    expect(() => validate({ ...BASE_ENV, RECONCILE_INTERVAL_MS: '60000' })).not.toThrow();
  });

  // configuration.ts reads these with `!== 'false'` or `=== 'true'`, so '0'/'1' must be refused
  // instead of silently loading as the opposite of what they validated as.
  it("refuses '0'/'1' for boolean switches instead of loading the opposite of what was set", () => {
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: '0' })).toThrow(/OUTBOX_RELAY_ENABLED/);
    expect(() => validate({ ...BASE_ENV, SEARCH_ENABLED: '1' })).toThrow(/SEARCH_ENABLED/);
    expect(() => validate({ ...BASE_ENV, OUTBOX_RELAY_ENABLED: 'false', SEARCH_ENABLED: 'true' })).not.toThrow();
  });

  // app.config.ts compares COOKIE_SECURE to the literal 'true'; '1' must not validate and then load
  // as false, or a production auth cookie loses Secure.
  it('refuses a non-literal COOKIE_SECURE', () => {
    expect(() => validate({ ...BASE_ENV, COOKIE_SECURE: '1' })).toThrow(/COOKIE_SECURE/);
    expect(() => validate({ ...BASE_ENV, COOKIE_SECURE: 'true' })).not.toThrow();
  });
});
