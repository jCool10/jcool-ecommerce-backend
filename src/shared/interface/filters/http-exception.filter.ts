import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { REQUEST_ID_HEADER, getCorrelationId, getDbQueryCount, getRequestDurationMs } from '@shared/observability';

// Plain number so comparisons don't mix enum/number (no-unsafe-enum-comparison).
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;

// pino `context` label; passed per-call because the base PinoLogger is a shared singleton.
const LOG_CONTEXT = 'HttpExceptionFilter';

/** Unified error envelope — < 500 keep their developer-chosen payload, >= 500 are masked to a generic message (real error logged) so internals never leak, and Terminus health results pass through unchanged. Every response carries the correlation `requestId` (envelope field + `x-request-id` header); the exception is logged ONCE — 4xx at warn, 5xx at error. See docs/engineering-notes.md (Shared — Unified exception filter) and ADR-0013. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = getCorrelationId(this.cls);

    // Terminus payload IS the HealthCheckResult — return as-is so the 503 body
    // stays symmetric with the 200. Terminus already logged it.
    if (this.isHealthCheckResult(exception)) {
      this.setRequestIdHeader(response, requestId);
      response.status(status).json(exception.getResponse());
      return;
    }

    // Log ONCE (anti log-and-throw): 4xx at warn, 5xx at error. requestId rides on the
    // line via the pino mixin; route + status keep it self-contained.
    // durationMs + db.queries mirror the canonical success line so a failed request can be
    // profiled from its log the same way a successful one can (e.g. a slow query that 500s).
    const logFields = {
      context: LOG_CONTEXT,
      statusCode: status,
      method: request.method,
      route: request.url,
      durationMs: getRequestDurationMs(this.cls),
      'db.queries': getDbQueryCount(this.cls),
    };
    if (status >= SERVER_ERROR_MIN) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({ ...logFields, err }, 'request failed');
    } else {
      this.logger.warn(logFields, 'request rejected');
    }

    this.setRequestIdHeader(response, requestId);
    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId,
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
