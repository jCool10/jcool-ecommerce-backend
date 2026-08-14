import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, tap } from 'rxjs';
import { getRequestDurationMs } from '../correlation/cls.setup';
import { resolveRouteTemplate } from '../http-route.util';
import { getDbQueryCount } from './db-query-counter';
import { formatDevRequestLine } from './dev-request-line.format';

// High-frequency operational endpoints logged every few seconds by orchestrators/Prometheus:
// health probes and the metrics scrape. A canonical line for each is pure noise, so skip them
// (the RED metrics interceptor skips /metrics for the same reason).
const SKIP_ROUTE_PREFIXES = ['/health', '/metrics'];

/**
 * Emits exactly one canonical "request completed" line per successfully handled HTTP
 * request: method, route TEMPLATE (not the concrete URL — keeps the id a log field, not
 * a label, and matches the Phase 2 metric label), status, durationMs and db.queries.
 * Errors are logged by HttpExceptionFilter instead (4xx warn / 5xx error), so a request
 * never yields two summary lines. See ADR-0013.
 */
@Injectable()
export class CanonicalLogInterceptor implements NestInterceptor {
  private readonly devPretty: boolean;

  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.devPretty = config.get<string>('app.env') === 'development';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const route = resolveRouteTemplate(this.reflector, context, request.path);

    if (SKIP_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix))) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode;
        const durationMs = getRequestDurationMs(this.cls);
        const dbQueries = getDbQueryCount(this.cls);

        if (this.devPretty) {
          this.logger.info(
            formatDevRequestLine({
              method: request.method,
              route,
              statusCode,
              durationMs,
              contentLength: response.getHeader('content-length'),
              dbQueries,
            }),
          );
          return;
        }

        this.logger.info(
          {
            context: CanonicalLogInterceptor.name,
            method: request.method,
            route,
            statusCode,
            durationMs,
            'db.queries': dbQueries,
          },
          'request completed',
        );
      }),
    );
  }
}
