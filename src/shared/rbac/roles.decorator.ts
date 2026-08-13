import { SetMetadata } from '@nestjs/common';
import type { Role } from './role.enum';

// Shared by the decorator (writes it) and RolesGuard (reads it).
export const ROLES_KEY = 'roles';

/** Restrict a handler/controller to the listed roles; RolesGuard denies 403 when the authenticated user's role is not among them (a route without `@Roles` only needs authentication). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
