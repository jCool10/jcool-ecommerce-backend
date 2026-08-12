import { SetMetadata } from '@nestjs/common';

// Shared by the decorator and the global JwtAuthGuard that reads it.
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt a handler/controller out of the global JwtAuthGuard. Fail-safe: absence
 * means "protected", so only routes reachable without a token carry it.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
