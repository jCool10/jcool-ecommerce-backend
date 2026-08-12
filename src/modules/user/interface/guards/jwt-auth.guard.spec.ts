import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The guard's own logic is the `@Public()` short-circuit; the actual token
 * verification is delegated to passport's AuthGuard('jwt') (covered by live
 * smoke). Here we prove: public → allow without delegating; not public →
 * delegate to the parent guard.
 */
describe('JwtAuthGuard', () => {
  function makeContext(): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  it('allows the request when the route is @Public() without delegating', () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    // Parent canActivate must NOT run on a public route.
    const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
      canActivate: (ctx: ExecutionContext) => unknown;
    };
    const parentSpy = vi.spyOn(parentProto, 'canActivate');

    expect(guard.canActivate(makeContext())).toBe(true);
    expect(parentSpy).not.toHaveBeenCalled();
    parentSpy.mockRestore();
  });

  it('delegates to passport authentication when the route is not public', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
      canActivate: (ctx: ExecutionContext) => unknown;
    };
    const parentSpy = vi.spyOn(parentProto, 'canActivate').mockReturnValue(true);

    expect(guard.canActivate(makeContext())).toBe(true);
    expect(parentSpy).toHaveBeenCalledTimes(1);
    parentSpy.mockRestore();
  });
});
