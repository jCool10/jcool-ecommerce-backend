import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { Reflector } from '@nestjs/core';

/**
 * Resolves the route TEMPLATE (`/products/:idOrSlug`), never the concrete path, so the canonical
 * log line and the RED metrics interceptor share one low-cardinality label instead of one series
 * per id. Falls back to the concrete path when no template exists.
 */
export function resolveRouteTemplate(reflector: Reflector, context: ExecutionContext, fallbackPath: string): string {
  const controllerPath = reflector.get<string>(PATH_METADATA, context.getClass()) ?? '';
  const handlerPath = reflector.get<string>(PATH_METADATA, context.getHandler()) ?? '';
  const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.length > 1 ? joined : fallbackPath;
}
