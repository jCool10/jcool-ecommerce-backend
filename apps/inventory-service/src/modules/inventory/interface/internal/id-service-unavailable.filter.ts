import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { ID_SERVICE_UNAVAILABLE, LOCK_BUDGET_EXHAUSTED_STATUS } from '@jcool/internal-contracts';
import { getCorrelationId } from '@jcool/platform/observability';
import { IdMintUnavailableError } from '../../domain/errors/id-mint-unavailable.error';
import { RETRY_AFTER_SEC } from './lock-budget-exhausted.filter';

const LOG_CONTEXT = 'IdServiceUnavailableFilter';

/**
 * Only a Try mints, and the id-service has its own breaker here, so this must not count against the
 * order-side breaker that Commit and Release share. Written here because the global filter masks every 5xx body.
 */
@Catch(IdMintUnavailableError)
export class IdServiceUnavailableFilter implements ExceptionFilter<IdMintUnavailableError> {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  catch(exception: IdMintUnavailableError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const statusCode = LOCK_BUDGET_EXHAUSTED_STATUS;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;

    this.logger.error(
      { err: exception.cause, statusCode, method: request.method, route },
      'request failed: id-service could not mint reservation ids',
    );
    const response = http.getResponse<Response>();
    response.setHeader('Retry-After', RETRY_AFTER_SEC);
    response.status(statusCode).json({
      statusCode,
      code: ID_SERVICE_UNAVAILABLE,
      message: 'Service unavailable',
      requestId: getCorrelationId(this.cls),
    });
  }
}
