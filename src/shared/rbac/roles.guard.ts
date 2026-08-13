import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from './role.enum';
import { ROLES_KEY } from './roles.decorator';

/** Global authorization guard (runs after JwtAuthGuard, so `request.user` is populated) — no `@Roles` allows, a listed role allows, otherwise 403; reads only `{ role }` to stay decoupled from the User context. See docs/engineering-notes.md (Shared — RBAC). */
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
