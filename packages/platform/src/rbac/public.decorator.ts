import { SetMetadata } from '@nestjs/common';

// Shared by the decorator and the global JwtAuthGuard that reads it.
export const IS_PUBLIC_KEY = 'isPublic';

/** Opts out of the global JwtAuthGuard. Fail-safe: absence means "protected", so only a route that
 * is meant to be reachable without a token carries it. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
