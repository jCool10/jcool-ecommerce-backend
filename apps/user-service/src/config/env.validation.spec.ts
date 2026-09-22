import 'reflect-metadata';
import { validate } from './env.validation';

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/users',
  REDIS_URL: 'redis://localhost:6379',
  IDENTITY_BUCKET_KEY: 'k'.repeat(64),
  JWT_ES256_PRIVATE_KEYS: 'k1:pem',
  JWT_ES256_ACTIVE_KID: 'k1',
  JWT_ISSUER: 'https://users.test.invalid',
  JWT_AUDIENCE: 'jcool',
  CSRF_SECRET: 'c'.repeat(32),
  ID_SERVICE_URL: 'http://gateway:4000',
  INTERNAL_API_TOKEN: 't'.repeat(32),
};

describe('validate', () => {
  it('accepts the minimal set', () => {
    expect(() => validate(BASE)).not.toThrow();
  });

  it.each(['CSRF_SECRET', 'INTERNAL_API_TOKEN', 'ID_SERVICE_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'IDENTITY_BUCKET_KEY'])(
    'requires %s',
    (name) => {
      expect(() => validate({ ...BASE, [name]: undefined })).toThrow(name);
    },
  );

  it.each(['AUTH_REQUIRE_VERIFIED_EMAIL', 'IDENTITY_PIN_BOOTSTRAP', 'SESSION_EPOCH_RECONCILE_ENABLED'])(
    'accepts only true or false for %s',
    (name) => {
      expect(() => validate({ ...BASE, [name]: '0' })).toThrow(name);
      expect(() => validate({ ...BASE, [name]: 'false' })).not.toThrow();
    },
  );

  it.each(['gateway:4000', 'ftp://gateway:4000'])('rejects %s as ID_SERVICE_URL', (url) => {
    expect(() => validate({ ...BASE, ID_SERVICE_URL: url })).toThrow('ID_SERVICE_URL');
  });

  it('accepts an internal host without a TLD as ID_SERVICE_URL', () => {
    expect(() => validate({ ...BASE, ID_SERVICE_URL: 'http://127.0.0.1:4000' })).not.toThrow();
    expect(() => validate({ ...BASE, ID_SERVICE_URL: 'http://gateway.railway.internal:4000' })).not.toThrow();
  });

  it('requires TRUST_PROXY and APP_PUBLIC_URL in production', () => {
    expect(() => validate({ ...BASE, NODE_ENV: 'production' })).toThrow('TRUST_PROXY, APP_PUBLIC_URL');
    expect(() =>
      validate({ ...BASE, NODE_ENV: 'production', TRUST_PROXY: 'fd12::/16', APP_PUBLIC_URL: 'https://shop.test' }),
    ).not.toThrow();
  });
});
