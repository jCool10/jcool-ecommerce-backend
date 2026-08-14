import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { Reflector } from '@nestjs/core';

/**
 * Resolve the route TEMPLATE (e.g. `/products/:idOrSlug`) from the matched controller +
 * handler metadata, independent of the concrete request path. Shared by the canonical log
 * line (Phase 1) and the RED metrics interceptor (Phase 2) so both label with the same
 * low-cardinality value — the id stays a log/span field, never a metric label (the
 * cardinality iron rule, ADR-0014). Falls back to the concrete path when no template exists
 * (e.g. an unmatched route).
 */
export function resolveRouteTemplate(reflector: Reflector, context: ExecutionContext, fallbackPath: string): string {
  const controllerPath = reflector.get<string>(PATH_METADATA, context.getClass()) ?? '';
  const handlerPath = reflector.get<string>(PATH_METADATA, context.getHandler()) ?? '';
  const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.length > 1 ? joined : fallbackPath;
}
