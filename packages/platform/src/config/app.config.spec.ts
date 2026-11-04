import { describe, expect, it } from 'vitest';
import { AppEnv } from './app.config';
import { EmptyEnv, validateEnv } from './validate-env';

const Env = AppEnv(EmptyEnv);
const validate = (extra: Record<string, unknown>) => validateEnv(Env, { NODE_ENV: 'test', ...extra });

describe('AppEnv', () => {
  // The loader compares COOKIE_SECURE to the literal 'true'; '1' must not validate and then load as
  // false, or a production auth cookie loses Secure.
  it('refuses a COOKIE_SECURE that is not the literal true or false', () => {
    expect(() => validate({ COOKIE_SECURE: '1' })).toThrow(/COOKIE_SECURE/);
  });

  it.each(['true', 'false'])('accepts COOKIE_SECURE=%s', (value) => {
    expect(validate({ COOKIE_SECURE: value }).COOKIE_SECURE).toBe(value);
  });

  it('accepts COOKIE_SECURE unset', () => {
    expect(validate({}).COOKIE_SECURE).toBeUndefined();
  });
});
