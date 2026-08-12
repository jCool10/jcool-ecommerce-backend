import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '../../../../shared/rbac/role.enum';

// Shape JwtStrategy.validate attaches to request.user — minimal (id + role), no
// DB round-trip. A handler needing more (e.g. email) loads it explicitly.
export interface AuthenticatedUser {
  userId: string;
  role: Role;
}

// Named function so it's unit-testable without Nest's decorator machinery.
export function currentUserFactory(_data: unknown, ctx: ExecutionContext): AuthenticatedUser {
  const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return request.user;
}

/** Inject the authenticated user `{ userId, role }`. Undefined on a public route. */
export const CurrentUser = createParamDecorator(currentUserFactory);
