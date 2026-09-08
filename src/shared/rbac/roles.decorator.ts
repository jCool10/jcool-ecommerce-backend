import { SetMetadata } from '@nestjs/common';
import type { Role } from './role.enum';

// Shared by the decorator (writes it) and RolesGuard (reads it).
export const ROLES_KEY = 'roles';

/** RolesGuard denies 403 when the authenticated user's role is not listed; a route without `@Roles`
 * only needs authentication. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
