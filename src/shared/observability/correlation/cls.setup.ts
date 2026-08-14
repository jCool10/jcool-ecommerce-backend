import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ClsModuleOptions, ClsService } from 'nestjs-cls';

/** Header that carries the correlation id across a hop (read on the way in, echoed out). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** CLS key holding the per-request correlation id (mirrors `cls.getId()`). */
export const REQUEST_ID_KEY = 'requestId';

/** CLS key holding the request-start timestamp (`process.hrtime.bigint()`) for durationMs. */
export const REQUEST_START_KEY = 'requestStart';

// Trust a caller-supplied x-request-id when present (lets a gateway/proxy stitch hops),
// otherwise mint a v4 UUID. Exactly one id per request, owned by CLS.
function resolveRequestId(req: Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied !== undefined && supplied.trim().length > 0 ? supplied : randomUUID();
}

/**
 * AsyncLocalStorage-backed correlation context. Mounted as middleware and imported
 * FIRST in AppModule (before the pino logger) so its middleware runs early and every
 * downstream log — and, from Phase 3, span — shares one requestId. See ADR-0013.
 */
export const clsModuleOptions: ClsModuleOptions = {
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: (req: Request): string => resolveRequestId(req),
    setup: (cls: ClsService, req: Request, res: Response): void => {
      const id = cls.getId();
      cls.set(REQUEST_ID_KEY, id);
      // Stamped here (before guards/pipes) so durationMs on both the success line and the
      // error line covers the whole request, not just the handler.
      cls.set(REQUEST_START_KEY, process.hrtime.bigint());
      // Echo the id so a client can line up its request with server logs/traces.
      res.setHeader(REQUEST_ID_HEADER, id);
    },
  },
};

/**
 * Correlation id for the active request: the CLS request id today, and — once the
 * OpenTelemetry SDK lands in Phase 3 — the active span's trace id in preference to it
 * (`trace.getActiveSpan()?.spanContext().traceId ?? cls.getId()`). Returns undefined
 * outside a request (startup, CLI scripts).
 */
export function getCorrelationId(cls: ClsService): string | undefined {
  return cls.isActive() ? cls.getId() : undefined;
}

/**
 * Milliseconds elapsed since the request-start stamp (3-decimal precision), or undefined
 * outside a request / before the stamp is set. Shared by the canonical log line and the
 * exception filter so success and error paths report duration the same way.
 */
export function getRequestDurationMs(cls: ClsService): number | undefined {
  if (!cls.isActive()) return undefined;
  const start = cls.get<bigint>(REQUEST_START_KEY);
  if (typeof start !== 'bigint') return undefined;
  return Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 1000) / 1000;
}
