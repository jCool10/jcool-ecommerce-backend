import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '../../../../shared/rbac/role.enum';

// Shape JwtStrategy.validate attaches to request.user (no DB round-trip); carries the access
// token's jti + exp so logout can denylist exactly this token — handlers needing more load it.
export interface AuthenticatedUser {
  userId: string;
  role: Role;
  /** Access-token id — logout denylists this to revoke the token. */
  jti: string;
  /** Access-token expiry (epoch seconds) — the denylist TTL horizon. */
  exp: number;
}

// Named function so it's unit-testable without Nest's decorator machinery.
export function currentUserFactory(_data: unknown, ctx: ExecutionContext): AuthenticatedUser {
  const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return request.user;
}

/** Inject the authenticated user `{ userId, role }`. Undefined on a public route. */
export const CurrentUser = createParamDecorator(currentUserFactory);
