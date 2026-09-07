import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, isObservable } from 'rxjs';
import { setLogActor } from '@shared/observability';
import { IS_PUBLIC_KEY } from '@shared/rbac';
import type { AuthenticatedUser } from '../decorators';

/** Global authentication guard — every route protected by default, `@Public()` opts out (fail-safe: forgetting the decorator leaves an endpoint protected, never open); delegates to Passport's `AuthGuard('jwt')` otherwise, then records the actor in CLS so every log line of the request names who made it. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // AuthGuard returns any of the three CanActivate shapes depending on how passport resolves;
    // normalize here so the actor is recorded only after authentication actually succeeded.
    const outcome = super.canActivate(context);
    const allowed = isObservable(outcome) ? await firstValueFrom(outcome) : await outcome;

    // Passport has assigned req.user by now. This is the one place every authenticated request
    // passes through, and it runs before the handler — so the actor is on the error lines too,
    // including a 500 thrown deep in a use case.
    this.recordActor(context);
    return allowed;
  }

  // Telemetry only: a failure here must never turn an authenticated request into a 500.
  private recordActor(context: ExecutionContext): void {
    if (context.getType() !== 'http') {
      return;
    }
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (user) {
      setLogActor(this.cls, { userId: user.userId, role: user.role });
    }
  }
}
