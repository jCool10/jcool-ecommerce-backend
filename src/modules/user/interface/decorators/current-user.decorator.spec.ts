import type { ExecutionContext } from '@nestjs/common';
import { currentUserFactory, type AuthenticatedUser } from './current-user.decorator';

describe('currentUserFactory', () => {
  function contextWithUser(user: AuthenticatedUser | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('returns request.user set by the strategy', () => {
    const user: AuthenticatedUser = { userId: 'user-1', role: 'CUSTOMER', jti: 'jti-1', exp: 100 };
    expect(currentUserFactory(undefined, contextWithUser(user))).toBe(user);
  });

  it('returns undefined when no user is attached (e.g. a public route)', () => {
    expect(currentUserFactory(undefined, contextWithUser(undefined))).toBeUndefined();
  });
});
