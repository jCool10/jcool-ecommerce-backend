import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Argon2PasswordHasher } from './argon2-password-hasher';

// Real argon2 rather than a mock — the roundtrip is the point, and it stays fast at the low params below.
describe('Argon2PasswordHasher', () => {
  const params: Record<string, number> = {
    'argon2.memoryCost': 19456,
    'argon2.timeCost': 2,
    'argon2.parallelism': 1,
  };
  const config = fakeConfigService(params);
  const error = vi.fn();
  const hasher = new Argon2PasswordHasher(config, fakePinoLogger({ error }));

  it('produces an argon2id digest that verifies against the original password', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('s3cret-password');

    await expect(hasher.verify(hash, 'not-the-password')).resolves.toBe(false);
  });

  // A stored hash that cannot be read locks its owner out until a reset, so someone has to look.
  it('returns false (never throws) for a malformed hash, and logs an error once', async () => {
    await expect(hasher.verify('not-a-real-hash', 'whatever')).resolves.toBe(false);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      { err: expect.objectContaining({ message: expect.any(String) as string }) as unknown },
      'password hash verify errored — treated as no match',
    );
  });
});
