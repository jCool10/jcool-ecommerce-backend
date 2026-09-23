import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Role } from './role.enum';
import { RolesGuard } from './roles.guard';

// The guard reads only a minimal `{ role }` shape, so the test user is that shape rather than a full
// AuthenticatedUser — the extra fields would assert nothing.
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

  it('allows a route whose @Roles list is empty', () => {
    expect(guardRequiring([]).canActivate(makeContext(CUSTOMER))).toBe(true);
  });

  it('allows when the user holds the single required role', () => {
    expect(guardRequiring([Role.Admin]).canActivate(makeContext(ADMIN))).toBe(true);
  });

  it('allows when the user matches one of several allowed roles', () => {
    expect(guardRequiring([Role.Admin, Role.Customer]).canActivate(makeContext(CUSTOMER))).toBe(true);
  });

  it('denies 403 (fail-safe) when @Roles is present but no user is attached', () => {
    expect(() => guardRequiring([Role.Admin]).canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });

  function caught(fn: () => unknown): unknown {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('carries which role was required vs held in `cause`, for the rejection log line only', () => {
    const error = caught(() => guardRequiring([Role.Admin]).canActivate(makeContext(CUSTOMER)));

    expect(error).toBeInstanceOf(ForbiddenException);
    const forbidden = error as ForbiddenException;
    expect((forbidden.cause as Error).message).toBe('required role ADMIN, held CUSTOMER');
    // Response body unchanged: message and the Nest-default `error` description still read 'Forbidden'.
    expect(forbidden.getResponse()).toEqual({
      statusCode: 403,
      message: 'Insufficient permissions',
      error: 'Forbidden',
    });
  });

  it('names "none" in `cause` when no user is attached', () => {
    const error = caught(() => guardRequiring([Role.Admin]).canActivate(makeContext(undefined)));

    expect(((error as ForbiddenException).cause as Error).message).toBe('required role ADMIN, held none');
  });
});
