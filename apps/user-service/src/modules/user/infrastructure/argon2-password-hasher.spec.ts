import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Argon2PasswordHasher } from './argon2-password-hasher';

// Real argon2 rather than a mock: the round trip is the point.
describe('Argon2PasswordHasher', () => {
  const config = fakeConfigService({ 'argon2.memoryCost': 19456, 'argon2.timeCost': 2, 'argon2.parallelism': 1 });
  const error = vi.fn();
  const hasher = new Argon2PasswordHasher(config, fakePinoLogger({ error }));

  it('produces an argon2id digest that verifies the original password and no other', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect([
      await hasher.verify(hash, 'correct horse battery staple'),
      await hasher.verify(hash, 'not-the-password'),
    ]).toEqual([true, false]);
  });

  // A stored hash that cannot be read locks its owner out until a reset, so someone has to look.
  it('answers false for a malformed hash and logs it as an error', async () => {
    await expect(hasher.verify('not-a-real-hash', 'whatever')).resolves.toBe(false);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      { err: expect.objectContaining({ message: expect.any(String) as string }) as unknown },
      expect.any(String),
    );
  });
});
