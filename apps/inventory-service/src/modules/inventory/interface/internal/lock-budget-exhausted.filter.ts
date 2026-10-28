import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import {
  LOCK_BUDGET_EXHAUSTED,
  LOCK_BUDGET_EXHAUSTED_STATUS,
  type LockBudgetExhaustedResponse,
} from '@jcool/internal-contracts';
import { getCorrelationId } from '@jcool/platform/observability';
import { ReservationTimeoutError } from '../../domain/errors/reservation-timeout.error';

// The saga retries on its own schedule; this only keeps a generic client from hammering.
export const RETRY_AFTER_SEC = '1';

const LOG_CONTEXT = 'LockBudgetExhaustedFilter';

/**
 * Rows held past the budget are contention, not a fault: the `code` is what keeps one hot SKU from
 * opening the caller's breaker for every other. Written here because the global filter masks every 5xx body.
 */
@Catch(ReservationTimeoutError)
export class LockBudgetExhaustedFilter implements ExceptionFilter<ReservationTimeoutError> {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  catch(_exception: ReservationTimeoutError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const statusCode = LOCK_BUDGET_EXHAUSTED_STATUS;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;

    this.logger.warn({ statusCode, method: request.method, route }, 'request rejected: lock budget exhausted');
    const body = {
      statusCode,
      code: LOCK_BUDGET_EXHAUSTED,
      message: 'Service unavailable',
      requestId: getCorrelationId(this.cls),
    } satisfies LockBudgetExhaustedResponse;
    const response = http.getResponse<Response>();
    response.setHeader('Retry-After', RETRY_AFTER_SEC);
    response.status(statusCode).json(body);
  }
}
