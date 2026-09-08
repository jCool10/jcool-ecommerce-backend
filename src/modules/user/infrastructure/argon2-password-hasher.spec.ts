import { ConfigService } from '@nestjs/config';
import { Argon2PasswordHasher } from './argon2-password-hasher';

// Real argon2 rather than a mock — the roundtrip is the point, and it stays fast at the low params below.
describe('Argon2PasswordHasher', () => {
  const params: Record<string, number> = {
    'argon2.memoryCost': 19456,
    'argon2.timeCost': 2,
    'argon2.parallelism': 1,
  };
  const config = { getOrThrow: (key: string) => params[key] } as unknown as ConfigService;
  const hasher = new Argon2PasswordHasher(config);

  it('produces an argon2id digest that verifies against the original password', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('s3cret-password');

    await expect(hasher.verify(hash, 'not-the-password')).resolves.toBe(false);
  });

  it('returns false (never throws) for a malformed hash', async () => {
    await expect(hasher.verify('not-a-real-hash', 'whatever')).resolves.toBe(false);
  });
});
