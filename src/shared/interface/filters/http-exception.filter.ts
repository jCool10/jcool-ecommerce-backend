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

/** Unified error envelope: <500 keep their payload, >=500 are masked to a generic message with the
 * real error logged. Every response carries the correlation requestId. */
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
    const route = request.url;
    const durationMs = getRequestDurationMs(this.cls);
    const dbQueries = getDbQueryCount(this.cls);
    const isServerError = status >= SERVER_ERROR_MIN;
    const err = isServerError ? (exception instanceof Error ? exception : new Error(String(exception))) : undefined;

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
      };
      if (isServerError) this.logger.error({ ...logFields, err }, 'request failed');
      else this.logger.warn(logFields, 'request rejected');
    }

    // Separate from requestId; only present when tracing is on. Added to the envelope only —
    // logs already carry it via the pino mixin.
    const traceId = getActiveTraceId();

    // Server errors only: 4xx are client errors and would be noise. A no-op when SENTRY_DSN is
    // unset. traceId/spanId land natively via the context manager; the tags make them searchable.
    if (isServerError && err) {
      try {
        const routeTemplate = (request.route as { path?: string } | undefined)?.path;
        Sentry.captureException(err, {
          tags: {
            request_id: requestId,
            trace_id: traceId,
            // Route template (low-cardinality, no query PII); falls back to the pathname.
            route: `${method} ${routeTemplate ?? request.path}`,
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
