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

/**
 * One canonical line per SUCCESSFUL request only: errors are logged by HttpExceptionFilter
 * instead, so a request never yields two summary lines.
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
          // content-length is set when Nest serializes the body, after this chain unwinds, so the
          // size is readable no earlier than 'finish'. 'close' is the backstop — an aborted response
          // never finishes, and a dropped request is one a developer needs to see; first fire wins.
          let logged = false;
          const logRequestLine = (): void => {
            if (logged) return;
            logged = true;
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
          };
          response.once('finish', logRequestLine);
          response.once('close', logRequestLine);
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
