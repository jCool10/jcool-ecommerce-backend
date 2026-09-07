import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { MockInstance } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import { of } from 'rxjs';
import { ACTOR_KEY } from '@shared/observability';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The guard's own logic is the `@Public()` short-circuit plus recording the actor for the log
 * lines; the actual token verification is delegated to passport's AuthGuard('jwt') (covered by
 * live smoke). Here we prove: public → allow without delegating; not public → delegate to the
 * parent guard and stamp who the caller is.
 */
describe('JwtAuthGuard', () => {
  // CLS double that records what the guard stored, and reports active/inactive on demand.
  function clsStub(active = true): ClsService & { stored: Record<string, unknown> } {
    const stored: Record<string, unknown> = {};
    return {
      stored,
      isActive: () => active,
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
    } as unknown as ClsService & { stored: Record<string, unknown> };
  }

  function makeContext(user?: unknown): ExecutionContext {
    return {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  // AuthGuard('jwt') is a mixin class, so its canActivate lives on JwtAuthGuard's prototype chain.
  type ParentGuard = { canActivate: (ctx: ExecutionContext) => unknown };

  function spyOnParent(): MockInstance<(ctx: ExecutionContext) => unknown> {
    const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as ParentGuard;
    return vi.spyOn(parentProto, 'canActivate');
  }

  it('allows the request when the route is @Public() without delegating', async () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const cls = clsStub();
    const guard = new JwtAuthGuard(reflector, cls);
    const parent = spyOnParent();

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);

    // Parent canActivate must NOT run on a public route.
    expect(parent).not.toHaveBeenCalled();
    // An anonymous route must leave the field absent, so `userId:*` is itself the
    // "authenticated traffic" filter in the log platform.
    expect(cls.stored).toEqual({});
    parent.mockRestore();
  });

  it('delegates to passport authentication when the route is not public', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector, clsStub());
    const parent = spyOnParent();
    parent.mockReturnValue(true);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);

    expect(parent).toHaveBeenCalledTimes(1);
    parent.mockRestore();
  });

  it('records the actor so every log line of the request names who made it', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const cls = clsStub();
    const guard = new JwtAuthGuard(reflector, cls);
    const parent = spyOnParent();
    parent.mockReturnValue(true);

    await guard.canActivate(makeContext({ userId: 'user-8', role: 'ADMIN', jti: 'j1', exp: 1 }));

    // id + role only — never the email, which lives solely in the auth audit trail.
    expect(cls.stored[ACTOR_KEY]).toEqual({ userId: 'user-8', role: 'ADMIN' });
    parent.mockRestore();
  });

  // AuthGuard resolves to any of the three CanActivate shapes; the actor must be recorded in all
  // of them, not just the one the current passport version happens to return.
  it.each([
    ['a promise', () => Promise.resolve(true)],
    ['an observable', () => of(true)],
    ['a plain boolean', () => true],
  ])('unwraps %s from the parent guard before recording the actor', async (_shape, outcome) => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const cls = clsStub();
    const guard = new JwtAuthGuard(reflector, cls);
    const parent = spyOnParent();
    parent.mockReturnValue(outcome());

    await expect(guard.canActivate(makeContext({ userId: 'u', role: 'USER' }))).resolves.toBe(true);

    expect(cls.stored[ACTOR_KEY]).toEqual({ userId: 'u', role: 'USER' });
    parent.mockRestore();
  });

  // Recording the actor is telemetry; an inactive CLS must not turn an authenticated request
  // into a 500.
  it('does not throw when CLS is inactive', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const cls = clsStub(false);
    const guard = new JwtAuthGuard(reflector, cls);
    const parent = spyOnParent();
    parent.mockReturnValue(true);

    await expect(guard.canActivate(makeContext({ userId: 'u', role: 'USER' }))).resolves.toBe(true);

    expect(cls.stored).toEqual({});
    parent.mockRestore();
  });
});
