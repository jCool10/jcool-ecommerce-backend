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

// Skip high-frequency probes (health, metrics scrape) — a canonical line each is pure noise.
const SKIP_ROUTE_PREFIXES = ['/health', '/metrics'];

// Mirrors configuration.ts; used only if the key is missing, so a partial ConfigService in a test
// cannot silently make every request slow (a 0 threshold would).
const DEFAULT_SLOW_REQUEST_MS = 1000;

/**
 * Emits one canonical "request completed" line per successful HTTP request: method, route
 * template, status, durationMs, db.queries. Errors are logged by HttpExceptionFilter instead,
 * so a request never yields two summary lines. See ADR-0013.
 */
@Injectable()
export class CanonicalLogInterceptor implements NestInterceptor {
  private readonly devPretty: boolean;
  private readonly slowRequestMs: number;

  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.devPretty = config.get<string>('app.env') === 'development';
    this.slowRequestMs = config.get<number>('log.slowRequestMs') ?? DEFAULT_SLOW_REQUEST_MS;
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

        // A slow success is invisible at `info` — it looks exactly like a fast one. Raising the
        // level makes the single alert rule teams already have (`level:warn`) cover latency too,
        // and `slow` is emitted only when true: a `false` on every line is bytes carrying no news.
        const slow = durationMs !== undefined && durationMs > this.slowRequestMs;
        const fields = {
          context: CanonicalLogInterceptor.name,
          method: request.method,
          route,
          statusCode,
          durationMs,
          'db.queries': dbQueries,
          ...(slow ? { slow } : {}),
        };

        if (slow) this.logger.warn(fields, 'request completed');
        else this.logger.info(fields, 'request completed');
      }),
    );
  }
}
