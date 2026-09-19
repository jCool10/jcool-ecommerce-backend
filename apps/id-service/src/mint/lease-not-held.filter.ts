import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { Counter } from 'prom-client';
import { LeaseNotHeldError } from '@jcool/id-generator';
import { getCorrelationId } from '@jcool/platform/observability';
import { ID_FENCE_REJECTIONS_TOTAL } from './mint.metrics';

export const LEASE_NOT_HELD = 'LEASE_NOT_HELD';

const LOG_CONTEXT = 'LeaseNotHeldFilter';

/** The `code` is the contract: callers treat it as "another replica can serve this", not as a fault. */
@Catch(LeaseNotHeldError)
export class LeaseNotHeldFilter implements ExceptionFilter<LeaseNotHeldError> {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    @InjectMetric(ID_FENCE_REJECTIONS_TOTAL) private readonly rejections: Counter,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  catch(exception: LeaseNotHeldError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const statusCode = HttpStatus.SERVICE_UNAVAILABLE;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;

    this.rejections.inc();
    this.logger.warn(
      { statusCode, method: request.method, route, state: exception.state },
      'request rejected: no node lease',
    );
    const body = {
      statusCode,
      code: LEASE_NOT_HELD,
      message: 'Service unavailable',
      requestId: getCorrelationId(this.cls),
    };
    http.getResponse<Response>().status(statusCode).json(body);
  }
}
