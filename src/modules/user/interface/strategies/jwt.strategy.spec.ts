import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/**
 * JwtStrategy is mostly declarative (options passed to passport-jwt). The one
 * piece of our own logic is `validate`: it must map verified claims onto the
 * minimal `{ userId, role }` shape without touching the DB.
 */
describe('JwtStrategy', () => {
  function makeStrategy(): JwtStrategy {
    // secretOrKey must be a non-empty string or passport-jwt's constructor throws.
    const config = {
      getOrThrow: () => 'test-secret-at-least-32-characters-long!!',
    } as unknown as ConfigService;
    return new JwtStrategy(config);
  }

  it('maps token claims to { userId, role }', () => {
    const strategy = makeStrategy();
    const result = strategy.validate({ sub: 'user-1', role: 'ADMIN', iat: 0, exp: 0 });
    expect(result).toEqual({ userId: 'user-1', role: 'ADMIN' });
  });

  it('carries the CUSTOMER role through unchanged', () => {
    const strategy = makeStrategy();
    const result = strategy.validate({ sub: 'user-2', role: 'CUSTOMER', iat: 0, exp: 0 });
    expect(result).toEqual({ userId: 'user-2', role: 'CUSTOMER' });
  });
});
