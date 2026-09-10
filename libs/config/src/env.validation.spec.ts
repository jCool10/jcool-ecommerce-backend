import 'reflect-metadata'; // class-validator decorators; the app gets it from @nestjs/core's bootstrap.
import { describe, expect, it } from 'vitest';
import { NodeEnv, validate, validateUser } from './env.validation';

// Only what BOTH deployables need. Each app's env below adds exactly its own variables, so a
// required variable that drifts onto the shared base fails one of these instead of a container.
const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  REDIS_URL: 'redis://localhost:6379',
  JWT_ES256_PUBLIC_KEY: 'not-a-real-key',
};

const CORE_ENV = {
  ...BASE_ENV,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
};

const USER_ENV = {
  ...BASE_ENV,
  USER_DATABASE_URL: 'postgresql://user:pw@localhost:5432/user_db',
  IDENTITY_LEASE_DATABASE_URL: 'postgresql://user:pw@localhost:5432/lease_db',
  IDENTITY_LEASE_SERVICE: 'user',
  JWT_ES256_PRIVATE_KEY: 'not-a-real-key',
  IDENTITY_BUCKET_KEY: 'test-identity-bucket-key-not-a-real-secret-000',
};

describe('env validation — IDENTITY_BUCKET_KEY', () => {
  it('accepts a user env that carries the key', () => {
    expect(validateUser(USER_ENV).IDENTITY_BUCKET_KEY).toBe(USER_ENV.IDENTITY_BUCKET_KEY);
  });

  it('refuses to boot when the key is missing', () => {
    const { IDENTITY_BUCKET_KEY: _missing, ...withoutKey } = USER_ENV;

    expect(() => validateUser(withoutKey)).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot when the key is shorter than 32 chars', () => {
    expect(() => validateUser({ ...USER_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(31) })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot on an empty key (dotenv writes "" rather than leaving it unset)', () => {
    expect(() => validateUser({ ...USER_ENV, IDENTITY_BUCKET_KEY: '' })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('accepts exactly 32 chars', () => {
    expect(() => validateUser({ ...USER_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(32) })).not.toThrow();
  });
});

// The whole point of two schemas: a deployment must fail on its own missing variables and must
// never be asked for a secret it has no business holding.
describe('env validation — per-app schemas', () => {
  it('boots commerce-core with none of the issuer’s variables', () => {
    expect(() => validate(CORE_ENV)).not.toThrow();
  });

  // The failure that shipped: DATABASE_URL sat on the shared base, so user-service could not boot
  // without a connection string to a database it must never reach.
  it('boots user-service without commerce-core’s DATABASE_URL', () => {
    expect(() => validateUser(USER_ENV)).not.toThrow();
  });

  it('refuses to boot commerce-core without DATABASE_URL', () => {
    expect(() => validate(BASE_ENV)).toThrow(/DATABASE_URL/);
  });

  it.each([
    'USER_DATABASE_URL',
    'IDENTITY_LEASE_DATABASE_URL',
    'IDENTITY_LEASE_SERVICE',
    'JWT_ES256_PRIVATE_KEY',
    'IDENTITY_BUCKET_KEY',
  ])(
    'refuses to boot user-service without %s',
    (key) => {
      const { [key]: _missing, ...incomplete } = USER_ENV as Record<string, string>;

      expect(() => validateUser(incomplete)).toThrow(new RegExp(key));
    },
  );

  // Both apps share one process.env in the e2e harness, so each schema has to tolerate the other's
  // variables rather than reject them.
  it.each([
    ['commerce-core', () => validate({ ...CORE_ENV, ...USER_ENV })],
    ['user-service', () => validateUser({ ...USER_ENV, ...CORE_ENV })],
  ])('ignores the sibling app’s variables instead of rejecting them (%s)', (_app, boot) => {
    expect(boot).not.toThrow();
  });
});

describe('env validation — retired inventory backoff key', () => {
  // validateSync runs without forbidNonWhitelisted, so an undeclared key is ignored while a
  // declared one can still fail a boot. Nothing reads this key any more, so it must stay undeclared
  // or a deployment that still carries it is the only thing the schema can reject.
  it('ignores a stale INVENTORY_OPTIMISTIC_BACKOFF_MS instead of refusing to boot', () => {
    expect(() => validate({ ...CORE_ENV, INVENTORY_OPTIMISTIC_BACKOFF_MS: 'not-a-number' })).not.toThrow();
  });
});
