import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from './role.enum';
import { ROLES_KEY } from './roles.decorator';

/** Runs after JwtAuthGuard, so `request.user` is populated. It reads only `{ role }`, which is what
 * keeps it decoupled from the User context. */
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
