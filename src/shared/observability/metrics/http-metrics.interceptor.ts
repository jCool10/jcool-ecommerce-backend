import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Request, Response } from 'express';
import type { Counter, Histogram } from 'prom-client';
import { type Observable, tap } from 'rxjs';
import { resolveRouteTemplate } from '../http-route.util';
import { HTTP_REQUESTS_TOTAL, HTTP_REQUEST_DURATION_SECONDS } from './metric-definitions';

// The scrape endpoint measures itself into noise; skip it. Every other route (health
// included) is measured so probe traffic is visible.
const METRICS_ROUTE = '/metrics';

/**
 * RED (Rate · Errors · Duration) for HTTP: observes `http_request_duration_seconds` and
 * increments `http_requests_total`, labelled by method, route TEMPLATE (not the concrete
 * URL — the cardinality iron rule) and status_code. Records on BOTH success and error: on
 * error the status is derived from the exception (the filter hasn't set response.statusCode
 * yet at this point in the chain), so a 500 is counted as a 500. ADR-0014.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric(HTTP_REQUEST_DURATION_SECONDS) private readonly duration: Histogram<string>,
    @InjectMetric(HTTP_REQUESTS_TOTAL) private readonly total: Counter<string>,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const route = resolveRouteTemplate(this.reflector, context, request.path);

    if (route === METRICS_ROUTE) {
      return next.handle();
    }

    const start = process.hrtime.bigint();
    const record = (statusCode: number): void => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method: request.method, route, status_code: statusCode };
      this.duration.observe(labels, seconds);
      this.total.inc(labels);
    };

    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (err: unknown) => record(statusFromError(err)),
      }),
    );
  }
}

// On the error path the response status isn't set yet, so derive it from the exception —
// matching what HttpExceptionFilter will ultimately send (non-HttpException → 500).
function statusFromError(err: unknown): number {
  return err instanceof HttpException ? err.getStatus() : 500;
}
