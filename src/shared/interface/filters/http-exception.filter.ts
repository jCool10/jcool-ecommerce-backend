import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

// Plain number so comparisons don't mix enum/number (no-unsafe-enum-comparison).
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;

/**
 * Unified error envelope: < 500 keep their developer-chosen payload, >= 500 are
 * masked to a generic message (real error logged) so internals never leak.
 * Terminus health results pass through unchanged.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Terminus payload IS the HealthCheckResult — return as-is so the 503 body
    // stays symmetric with the 200. Terminus already logged it.
    if (this.isHealthCheckResult(exception)) {
      response.status(status).json(exception.getResponse());
      return;
    }

    if (status >= SERVER_ERROR_MIN) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      message: this.resolveMessage(exception, status),
    });
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
