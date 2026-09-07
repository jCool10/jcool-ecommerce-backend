import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ClsModuleOptions, ClsService } from 'nestjs-cls';

/** Header that carries the correlation id across a hop (read on the way in, echoed out). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** CLS key holding the per-request correlation id (mirrors `cls.getId()`). */
export const REQUEST_ID_KEY = 'requestId';

/** CLS key holding the request-start timestamp (`process.hrtime.bigint()`) for durationMs. */
export const REQUEST_START_KEY = 'requestStart';

/** CLS key holding the authenticated actor, once a guard has resolved one. */
export const ACTOR_KEY = 'actor';

/**
 * Who the active request is acting as. Id and role only: `userId` is a UUIDv8 (ADR-0024), not an
 * email — the auth audit trail (ADR-0013) stays the single place that holds a direct identifier,
 * so putting the actor on every log line narrows the PII surface rather than widening it.
 */
export interface LogActor {
  userId: string;
  role: string;
}

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

/**
 * Record the authenticated actor for the rest of the request, so the pino mixin can stamp it on
 * every line. A no-op outside a request: a background caller has no actor, and throwing here would
 * turn a logging concern into a failed request.
 */
export function setLogActor(cls: ClsService, actor: LogActor): void {
  if (cls.isActive()) {
    cls.set(ACTOR_KEY, actor);
  }
}

/** The actor for the active request, or undefined on an anonymous route / outside a request. */
export function getLogActor(cls: ClsService): LogActor | undefined {
  return cls.isActive() ? cls.get<LogActor>(ACTOR_KEY) : undefined;
}

/** Milliseconds since the request-start stamp (3-decimal), or undefined outside a request. */
export function getRequestDurationMs(cls: ClsService): number | undefined {
  if (!cls.isActive()) return undefined;
  const start = cls.get<bigint>(REQUEST_START_KEY);
  if (typeof start !== 'bigint') return undefined;
  return Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 1000) / 1000;
}
