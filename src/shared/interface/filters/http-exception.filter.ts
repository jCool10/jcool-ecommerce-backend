import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
// The error module, never the barrel: a status mapping must not pull the generator into this
// filter's import graph.
import { ClockStalledError } from '@shared/identity/identity.errors';
import {
  REQUEST_ID_HEADER,
  formatDevRequestLine,
  getActiveTraceId,
  getCorrelationId,
  getDbQueryCount,
  getRequestDurationMs,
} from '@shared/observability';

// Plain numbers so comparisons don't mix enum/number (no-unsafe-enum-comparison).
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;
const SERVICE_UNAVAILABLE: number = HttpStatus.SERVICE_UNAVAILABLE;

// pino `context` label; passed per-call because the base PinoLogger is a shared singleton.
const LOG_CONTEXT = 'HttpExceptionFilter';

/**
 * The query-free identity of the route. Express fills `req.route` once the router matches, giving
 * the template (`/products/:idOrSlug`) — low-cardinality and groupable. `req.url` is never used: it
 * carries the query string, and `/auth/verify-email?token=…` therefore carries a live secret.
 *
 * A catch-all template is discarded. Express 5 matches unmatched requests against its own wildcard
 * route, so `req.route` is set even on a 404 and reports `/{*path}` — which is the same string for
 * every 404 and answers nothing. The concrete `req.path` is the useful identity there, and it has
 * the query string stripped, so dropping the template costs no safety.
 *
 * `ExceptionFilter` receives an `ArgumentsHost`, which has no `getClass()`/`getHandler()`, so the
 * reflector-based `resolveRouteTemplate` used by the canonical interceptor is not reachable here.
 */
function resolveRoute(request: Request): string {
  const template = (request.route as { path?: string } | undefined)?.path;
  if (!template || template.includes('*')) {
    return request.path;
  }
  return `${request.baseUrl ?? ''}${template}`;
}

// Node and several drivers put their machine-readable reason on `.code`; anything else is ignored
// so a caller-controlled value can never widen the field's shape.
function resolveErrorCode(exception: unknown): string | undefined {
  const code = (exception as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Unified error envelope: <500 keep their payload, >=500 are masked to a generic message (real error logged); Terminus health results pass through. Every response carries the correlation requestId; the exception is logged once (4xx warn, 5xx error). See docs/engineering-notes.md and ADR-0013. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly devPretty: boolean;

  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    config: ConfigService,
  ) {
    this.devPretty = config.get<string>('app.env') === 'development';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = this.resolveStatus(exception);
    const requestId = getCorrelationId(this.cls);

    // Terminus payload IS the HealthCheckResult — return as-is; Terminus already logged it.
    if (this.isHealthCheckResult(exception)) {
      this.setRequestIdHeader(response, requestId);
      response.status(status).json(exception.getResponse());
      return;
    }

    const method = request.method;
    // The route TEMPLATE, never `request.url`. `/auth/verify-email?token=…` and
    // `/auth/reset-password?token=…` carry single-use credentials on the query string, and the 4xx
    // paths on those routes (expired token, already-used token) are precisely the ones that log —
    // so the raw url wrote a live secret into the log platform on the most common failure. A redact
    // path cannot reach it: the secret is a substring of a value, not a key. Dropping the id also
    // collapses the cardinality of this field from per-request to per-route.
    const route = resolveRoute(request);
    const durationMs = getRequestDurationMs(this.cls);
    const dbQueries = getDbQueryCount(this.cls);
    const isServerError = status >= SERVER_ERROR_MIN;
    const err = isServerError ? (exception instanceof Error ? exception : new Error(String(exception))) : undefined;
    const errorName = exception instanceof Error ? exception.constructor.name : undefined;
    const errorCode = resolveErrorCode(exception);

    if (this.devPretty) {
      const line = formatDevRequestLine({
        method,
        route,
        statusCode: status,
        durationMs,
        contentLength: response.getHeader('content-length'),
        dbQueries,
      });
      // 5xx still carries the stack (as an object) so the pretty console prints it below the line.
      if (isServerError) this.logger.error({ err }, line);
      else this.logger.warn(line);
    } else {
      const logFields = {
        context: LOG_CONTEXT,
        statusCode: status,
        method,
        route,
        durationMs,
        'db.queries': dbQueries,
        // Flat and queryable: the class name (BadRequestException, ClockStalledError) and the
        // infra code when the error carries one — ECONNREFUSED when Postgres dies, EOPENBREAKER
        // when a circuit opens. The serialized `err` holds the class as a nested `type` and does
        // not carry `code` at all, so neither is reachable by a flat filter without these.
        ...(errorName ? { errorName } : {}),
        ...(errorCode ? { errorCode } : {}),
      };
      if (isServerError) this.logger.error({ ...logFields, err }, 'request failed');
      else this.logger.warn(logFields, 'request rejected');
    }

    // Separate from requestId; only present when tracing is on. Added to the envelope only —
    // logs already carry it via the pino mixin.
    const traceId = getActiveTraceId();

    // Report server errors to Sentry (no-op when SENTRY_DSN is unset, so tests/dev are unaffected).
    // traceId/spanId also land on the event natively via the Sentry context manager; the tags make
    // requestId/traceId searchable in issue search. 4xx are client errors — not reported (noise).
    if (isServerError && err) {
      // Fire-and-forget: reporting must never break the error response. captureException is
      // contractually non-throwing (no-op without a DSN), but guard the masking path regardless.
      try {
        Sentry.captureException(err, {
          tags: {
            request_id: requestId,
            trace_id: traceId,
            // Same query-free route as the log line — one resolver so the two cannot drift.
            route: `${method} ${route}`,
          },
        });
      } catch {
        // swallow — a telemetry failure must not affect the error response
      }
    }

    this.setRequestIdHeader(response, requestId);
    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId,
      ...(traceId ? { traceId } : {}),
      message: this.resolveMessage(exception, status),
    });
  }

  // Echo the correlation id (defensive — the CLS middleware already sets it on the way in).
  private setRequestIdHeader(response: Response, requestId: string | undefined): void {
    if (requestId !== undefined && response.getHeader(REQUEST_ID_HEADER) === undefined) {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }
  }

  private resolveStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    // Transient host fault, not a handler bug — the caller may retry. Mapped here so every mint path
    // answers alike.
    if (exception instanceof ClockStalledError) {
      return SERVICE_UNAVAILABLE;
    }
    return SERVER_ERROR_MIN;
  }

  private resolveMessage(exception: unknown, status: number): unknown {
    // Never leak internals: any >= 500 is genericized, but "retry later" is worth saying out loud.
    if (status >= SERVER_ERROR_MIN) {
      return status === SERVICE_UNAVAILABLE ? 'Service unavailable' : 'Internal server error';
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return payload;
      }
      // Nest wraps validation errors as { statusCode, message, error }.
      const nested = (payload as { message?: unknown }).message;
      return nested ?? payload;
    }

    return 'Unexpected error';
  }

  // Shape-based (not route/type) so a hand-thrown 5xx with a raw string is still masked.
  private isHealthCheckResult(exception: unknown): exception is HttpException {
    if (!(exception instanceof HttpException)) {
      return false;
    }
    const payload = exception.getResponse();
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'status' in payload &&
      'info' in payload &&
      'error' in payload &&
      'details' in payload
    );
  }
}
