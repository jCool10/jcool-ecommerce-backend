import type { ConfigService } from '@nestjs/config';
import type { SessionEpochPort } from '../../application/ports/session-epoch.port';
import type { TokenDenylistPort } from '../../application/ports/token-denylist.port';
import { JwtStrategy } from './jwt.strategy';

/**
 * JwtStrategy is mostly declarative (options passed to passport-jwt). Its own
 * logic is `validate`: reject a denylisted (logged-out) jti or a token whose
 * epoch predates the user's current one (a logout-all / change-password), else
 * map the verified claims onto `{ userId, role, jti, exp }` without a DB round for
 * the claims themselves (the epoch read is the one stateful lookup).
 */
describe('JwtStrategy', () => {
  function makeStrategy(opts: { denylisted?: boolean; currentEpoch?: number | null } = {}): JwtStrategy {
    const { denylisted = false, currentEpoch = 0 } = opts;
    // secretOrKey must be a non-empty string or passport-jwt's constructor throws.
    const config = {
      getOrThrow: () => 'test-secret-at-least-32-characters-long!!',
    } as unknown as ConfigService;
    const denylist: TokenDenylistPort = {
      denylist: () => Promise.resolve(),
      isDenylisted: () => Promise.resolve(denylisted),
    };
    const sessionEpoch: SessionEpochPort = {
      current: () => Promise.resolve(currentEpoch),
      bump: () => Promise.resolve(1),
    };
    return new JwtStrategy(config, denylist, sessionEpoch);
  }

  it('maps token claims to { userId, role, jti, exp } for a live token', async () => {
    const strategy = makeStrategy();
    await expect(
      strategy.validate({ sub: 'user-1', role: 'ADMIN', jti: 'j1', epoch: 0, iat: 0, exp: 100 }),
    ).resolves.toEqual({
      userId: 'user-1',
      role: 'ADMIN',
      jti: 'j1',
      exp: 100,
    });
  });

  it('carries the CUSTOMER role through unchanged', async () => {
    const strategy = makeStrategy();
    await expect(
      strategy.validate({ sub: 'user-2', role: 'CUSTOMER', jti: 'j2', epoch: 0, iat: 0, exp: 200 }),
    ).resolves.toEqual({
      userId: 'user-2',
      role: 'CUSTOMER',
      jti: 'j2',
      exp: 200,
    });
  });

  it('accepts a token whose epoch matches the user’s current epoch', async () => {
    const strategy = makeStrategy({ currentEpoch: 4 });
    await expect(
      strategy.validate({ sub: 'user-4', role: 'CUSTOMER', jti: 'j4', epoch: 4, iat: 0, exp: 400 }),
    ).resolves.toMatchObject({ userId: 'user-4' });
  });

  it('rejects a denylisted (logged-out) token with 401', async () => {
    const strategy = makeStrategy({ denylisted: true });
    await expect(
      strategy.validate({ sub: 'user-3', role: 'CUSTOMER', jti: 'j3', epoch: 0, iat: 0, exp: 300 }),
    ).rejects.toThrow(/revoked/i);
  });

  it('rejects a token whose epoch predates the user’s current epoch (logout-all)', async () => {
    const strategy = makeStrategy({ currentEpoch: 2 });
    await expect(
      strategy.validate({ sub: 'user-5', role: 'CUSTOMER', jti: 'j5', epoch: 1, iat: 0, exp: 500 }),
    ).rejects.toThrow(/revoked/i);
  });

  it('rejects when the user no longer exists (null epoch)', async () => {
    const strategy = makeStrategy({ currentEpoch: null });
    await expect(
      strategy.validate({ sub: 'gone', role: 'CUSTOMER', jti: 'j6', epoch: 0, iat: 0, exp: 600 }),
    ).rejects.toThrow(/revoked/i);
  });
});
