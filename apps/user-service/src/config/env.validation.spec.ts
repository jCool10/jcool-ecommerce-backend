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

/** The validation message, or null when the environment is accepted. */
function refusal(env: Record<string, unknown>): string | null {
  try {
    validate(env);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('validate', () => {
  it('accepts the minimal set and names each required variable that is missing', () => {
    const required = [
      'CSRF_SECRET',
      'INTERNAL_API_TOKEN',
      'ID_SERVICE_URL',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'IDENTITY_BUCKET_KEY',
    ];

    expect(refusal(BASE)).toBeNull();
    expect(required.filter((name) => refusal({ ...BASE, [name]: undefined })?.includes(name))).toEqual(required);
  });

  // configuration.ts compares against the literal 'true', so '0' or '1' would be silently misread.
  it("accepts only 'true' or 'false' for the boolean switches", () => {
    const flags = ['AUTH_REQUIRE_VERIFIED_EMAIL', 'IDENTITY_PIN_BOOTSTRAP', 'SESSION_EPOCH_RECONCILE_ENABLED'];

    expect(flags.filter((name) => refusal({ ...BASE, [name]: '0' })?.includes(name))).toEqual(flags);
    expect(flags.map((name) => refusal({ ...BASE, [name]: 'false' }))).toEqual([null, null, null]);
  });

  it('requires an http(s) ID_SERVICE_URL but no public TLD', () => {
    const urls = [
      'gateway:4000',
      'ftp://gateway:4000',
      'http://127.0.0.1:4000',
      'http://gateway.railway.internal:4000',
    ];

    const answers = urls.map(
      (url) => refusal({ ...BASE, ID_SERVICE_URL: url })?.includes('ID_SERVICE_URL') ?? 'accepted',
    );

    expect(answers).toEqual([true, true, 'accepted', 'accepted']);
  });

  it('requires TRUST_PROXY and APP_PUBLIC_URL in production', () => {
    expect(refusal({ ...BASE, NODE_ENV: 'production' })).toContain('TRUST_PROXY, APP_PUBLIC_URL');
    expect(
      refusal({ ...BASE, NODE_ENV: 'production', TRUST_PROXY: 'fd12::/16', APP_PUBLIC_URL: 'https://shop.test' }),
    ).toBeNull();
  });
});
