import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { Reflector } from '@nestjs/core';

/**
 * Resolve the route TEMPLATE (e.g. `/products/:idOrSlug`) from controller + handler metadata,
 * independent of the concrete path. Shared by the canonical log line and the RED metrics
 * interceptor so both use the same low-cardinality label (never the id — ADR-0014). Falls
 * back to the concrete path when no template exists.
 */
export function resolveRouteTemplate(reflector: Reflector, context: ExecutionContext, fallbackPath: string): string {
  const controllerPath = reflector.get<string>(PATH_METADATA, context.getClass()) ?? '';
  const handlerPath = reflector.get<string>(PATH_METADATA, context.getHandler()) ?? '';
  const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.length > 1 ? joined : fallbackPath;
}
