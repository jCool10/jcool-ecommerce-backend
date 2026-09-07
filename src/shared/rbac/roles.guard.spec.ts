import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Role } from './role.enum';
import { RolesGuard } from './roles.guard';

/**
 * RolesGuard decides authorize/deny from the `@Roles` metadata vs
 * `request.user.role`. The metadata read (getAllAndOverride over handler+class)
 * and the request are both faked, matching jwt-auth.guard.spec's style. The
 * guard reads only a minimal `{ role }` shape, so the test user is that shape
 * rather than a full AuthenticatedUser — the extra fields would assert nothing.
 */
describe('RolesGuard', () => {
  const ADMIN = { role: Role.Admin };
  const CUSTOMER = { role: Role.Customer };

  function makeContext(user: { role: Role } | undefined): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  function guardRequiring(required: Role[] | undefined): RolesGuard {
    const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('allows a route with no @Roles metadata (auth-only, no role restriction)', () => {
    expect(guardRequiring(undefined).canActivate(makeContext(CUSTOMER))).toBe(true);
  });

  it('allows a route whose @Roles list is empty', () => {
    expect(guardRequiring([]).canActivate(makeContext(CUSTOMER))).toBe(true);
  });

  it('allows when the user holds the single required role', () => {
    expect(guardRequiring([Role.Admin]).canActivate(makeContext(ADMIN))).toBe(true);
  });

  it('allows when the user matches one of several allowed roles', () => {
    expect(guardRequiring([Role.Admin, Role.Customer]).canActivate(makeContext(CUSTOMER))).toBe(true);
  });

  it('denies 403 when the authenticated user lacks the required role', () => {
    expect(() => guardRequiring([Role.Admin]).canActivate(makeContext(CUSTOMER))).toThrow(ForbiddenException);
  });

  it('denies 403 (fail-safe) when @Roles is present but no user is attached', () => {
    expect(() => guardRequiring([Role.Admin]).canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });
});
