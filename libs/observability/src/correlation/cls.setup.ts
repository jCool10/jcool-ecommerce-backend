import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ClsModuleOptions, ClsService } from 'nestjs-cls';

export const REQUEST_ID_HEADER = 'x-request-id';

export const REQUEST_ID_KEY = 'requestId';

export const REQUEST_START_KEY = 'requestStart';

// Trust a caller-supplied x-request-id (lets a proxy stitch hops); otherwise mint a UUID.
function resolveRequestId(req: Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied !== undefined && supplied.trim().length > 0 ? supplied : randomUUID();
}

/**
 * Import ahead of the pino logger in AppModule, so every downstream log shares one requestId.
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

/** Client-facing correlation id — deliberately distinct from the trace id ({@link getActiveTraceId}). */
export function getCorrelationId(cls: ClsService): string | undefined {
  return cls.isActive() ? cls.getId() : undefined;
}

export function getRequestDurationMs(cls: ClsService): number | undefined {
  if (!cls.isActive()) return undefined;
  const start = cls.get<bigint>(REQUEST_START_KEY);
  if (typeof start !== 'bigint') return undefined;
  return Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 1000) / 1000;
}
