import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from './role.enum';
import { ROLES_KEY } from './roles.decorator';

/**
 * Global authorization guard, registered after JwtAuthGuard so `request.user` is
 * already populated. No `@Roles` → allow; role listed → allow; otherwise 403.
 * The no-user branch is a fail-safe against a route marked both `@Roles` and
 * `@Public()`. Reads only `{ role }` off request.user to stay decoupled from the
 * User context.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user?: { role?: Role } }>();
    if (!user || user.role === undefined || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
