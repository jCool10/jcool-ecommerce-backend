import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ClsModuleOptions, ClsService } from 'nestjs-cls';

/** Header that carries the correlation id across a hop (read on the way in, echoed out). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** CLS key holding the per-request correlation id (mirrors `cls.getId()`). */
export const REQUEST_ID_KEY = 'requestId';

/** CLS key holding the request-start timestamp (`process.hrtime.bigint()`) for durationMs. */
export const REQUEST_START_KEY = 'requestStart';

// Trust a caller-supplied x-request-id (lets a proxy stitch hops); otherwise mint a UUID.
function resolveRequestId(req: Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied !== undefined && supplied.trim().length > 0 ? supplied : randomUUID();
}

/**
 * AsyncLocalStorage-backed correlation context. Import FIRST in AppModule (before the pino
 * logger) so every downstream log shares one requestId. See ADR-0013.
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
      // Stamp before guards/pipes so durationMs covers the whole request, not just the handler.
      cls.set(REQUEST_START_KEY, process.hrtime.bigint());
      res.setHeader(REQUEST_ID_HEADER, id);
    },
  },
};

/**
 * Client-facing correlation id for the active request (the CLS request id), or undefined
 * outside a request. Distinct from the trace id ({@link getActiveTraceId}). See ADR-0013.
 */
export function getCorrelationId(cls: ClsService): string | undefined {
  return cls.isActive() ? cls.getId() : undefined;
}

/** Milliseconds since the request-start stamp (3-decimal), or undefined outside a request. */
export function getRequestDurationMs(cls: ClsService): number | undefined {
  if (!cls.isActive()) return undefined;
  const start = cls.get<bigint>(REQUEST_START_KEY);
  if (typeof start !== 'bigint') return undefined;
  return Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 1000) / 1000;
}
