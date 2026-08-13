import type { ConfigService } from '@nestjs/config';
import type { TokenDenylistPort } from '../../application/ports/token-denylist.port';
import { JwtStrategy } from './jwt.strategy';

/**
 * JwtStrategy is mostly declarative (options passed to passport-jwt). Its own
 * logic is `validate`: reject a denylisted (logged-out) jti, otherwise map the
 * verified claims onto `{ userId, role, jti, exp }` without touching the DB.
 */
describe('JwtStrategy', () => {
  function makeStrategy(denylisted = false): JwtStrategy {
    // secretOrKey must be a non-empty string or passport-jwt's constructor throws.
    const config = {
      getOrThrow: () => 'test-secret-at-least-32-characters-long!!',
    } as unknown as ConfigService;
    const denylist: TokenDenylistPort = {
      denylist: () => Promise.resolve(),
      isDenylisted: () => Promise.resolve(denylisted),
    };
    return new JwtStrategy(config, denylist);
  }

  it('maps token claims to { userId, role, jti, exp } for a live token', async () => {
    const strategy = makeStrategy(false);
    await expect(strategy.validate({ sub: 'user-1', role: 'ADMIN', jti: 'j1', iat: 0, exp: 100 })).resolves.toEqual({
      userId: 'user-1',
      role: 'ADMIN',
      jti: 'j1',
      exp: 100,
    });
  });

  it('carries the CUSTOMER role through unchanged', async () => {
    const strategy = makeStrategy(false);
    await expect(strategy.validate({ sub: 'user-2', role: 'CUSTOMER', jti: 'j2', iat: 0, exp: 200 })).resolves.toEqual({
      userId: 'user-2',
      role: 'CUSTOMER',
      jti: 'j2',
      exp: 200,
    });
  });

  it('rejects a denylisted (logged-out) token with 401', async () => {
    const strategy = makeStrategy(true);
    await expect(strategy.validate({ sub: 'user-3', role: 'CUSTOMER', jti: 'j3', iat: 0, exp: 300 })).rejects.toThrow(
      /revoked/i,
    );
  });
});
