import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import {
  REQUEST_ID_HEADER,
  formatDevRequestLine,
  getActiveTraceId,
  getCorrelationId,
  getDbQueryCount,
  getRequestDurationMs,
} from '@shared/observability';

// Plain number so comparisons don't mix enum/number (no-unsafe-enum-comparison).
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;

// pino `context` label; passed per-call because the base PinoLogger is a shared singleton.
const LOG_CONTEXT = 'HttpExceptionFilter';

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

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
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

    // Report server errors to Sentry (no-op when SENTRY_DSN is unset, so tests/dev are unaffected).
    // traceId/spanId also land on the event natively via the Sentry context manager; the tags make
    // requestId/traceId searchable in issue search. 4xx are client errors — not reported (noise).
    if (isServerError && err) {
      // Fire-and-forget: reporting must never break the error response. captureException is
      // contractually non-throwing (no-op without a DSN), but guard the masking path regardless.
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

  private resolveMessage(exception: unknown, status: number): unknown {
    // Never leak internals: any >= 500 is genericized.
    if (status >= SERVER_ERROR_MIN) {
      return 'Internal server error';
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
