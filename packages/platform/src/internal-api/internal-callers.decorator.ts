import { SetMetadata } from '@nestjs/common';

export const INTERNAL_CALLERS_KEY = 'internalCallers';

/** The services allowed on a route. CallerTokenGuard refuses a route that does not declare any. */
export const InternalCallers = (...callers: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(INTERNAL_CALLERS_KEY, callers);
