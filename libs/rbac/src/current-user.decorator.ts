import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from './role.enum';

// What JwtStrategy.validate attaches to request.user, with no DB round-trip: jti and exp are here
// so logout can denylist exactly this token. A handler needing more has to load it.
export interface AuthenticatedUser {
  userId: string;
  role: Role;
  /** From the token, not the database — the address that held the session, snapshotted by checkout. */
  email: string;
  jti: string;
  /** Epoch seconds — the denylist TTL horizon. */
  exp: number;
}

// Named function so it's unit-testable without Nest's decorator machinery.
export function currentUserFactory(_data: unknown, ctx: ExecutionContext): AuthenticatedUser {
  const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
  return request.user;
}

/** Undefined on a public route, despite what the factory's return type promises. */
export const CurrentUser = createParamDecorator(currentUserFactory);
