import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import {
  PROVIDER_UNAVAILABLE,
  PROVIDER_UNAVAILABLE_STATUS,
  type ProviderUnavailableResponse,
} from '@jcool/internal-contracts';
import { getCorrelationId } from '@jcool/platform/observability';
import { PaymentGatewayError } from '../../application/public/payment-participant.port';

// The saga retries on its own schedule; this only keeps a generic client from hammering.
export const RETRY_AFTER_SEC = '1';

const LOG_CONTEXT = 'ProviderUnavailableFilter';

/**
 * Stripe being away is not payment-service being down: the `code` keeps the caller's breaker shut,
 * so status reads and cancels still get through. Written here because the global filter masks every 5xx body.
 */
@Catch(PaymentGatewayError)
export class ProviderUnavailableFilter implements ExceptionFilter<PaymentGatewayError> {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  catch(exception: PaymentGatewayError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const statusCode = PROVIDER_UNAVAILABLE_STATUS;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;

    this.logger.warn(
      { statusCode, method: request.method, route, err: exception },
      'request rejected: provider unavailable',
    );
    const body = {
      statusCode,
      code: PROVIDER_UNAVAILABLE,
      message: 'Service unavailable',
      requestId: getCorrelationId(this.cls),
    } satisfies ProviderUnavailableResponse;
    const response = http.getResponse<Response>();
    response.setHeader('Retry-After', RETRY_AFTER_SEC);
    response.status(statusCode).json(body);
  }
}
