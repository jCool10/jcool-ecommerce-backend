import 'reflect-metadata'; // class-validator decorators; the app gets it from @nestjs/core's bootstrap.
import { describe, expect, it } from 'vitest';
import { NodeEnv, validate } from './env.validation';

// The minimum a boot needs to get past every other required var, so each case below isolates one.
const BASE_ENV = {
  NODE_ENV: NodeEnv.Test,
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-jwt-access-secret-not-a-real-secret-000',
  IDENTITY_BUCKET_KEY: 'test-identity-bucket-key-not-a-real-secret-000',
};

describe('env validation — IDENTITY_BUCKET_KEY', () => {
  it('accepts a base env that carries the key', () => {
    expect(validate(BASE_ENV).IDENTITY_BUCKET_KEY).toBe(BASE_ENV.IDENTITY_BUCKET_KEY);
  });

  it('refuses to boot when the key is missing', () => {
    const { IDENTITY_BUCKET_KEY: _missing, ...withoutKey } = BASE_ENV;

    expect(() => validate(withoutKey)).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot when the key is shorter than 32 chars', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(31) })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('refuses to boot on an empty key (dotenv writes "" rather than leaving it unset)', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: '' })).toThrow(/IDENTITY_BUCKET_KEY/);
  });

  it('accepts exactly 32 chars', () => {
    expect(() => validate({ ...BASE_ENV, IDENTITY_BUCKET_KEY: 'a'.repeat(32) })).not.toThrow();
  });
});
