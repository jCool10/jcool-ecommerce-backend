import { type ArgumentsHost, Catch, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiServiceUnavailableResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import type { CheckoutSagaConfig } from '../../../config/checkout-saga.config';
import { CheckoutReadUnavailableError, CheckoutUnavailableError } from '../application/checkout-unavailable.error';

export const ApiCheckoutUnavailableResponse = (description: string) =>
  ApiServiceUnavailableResponse({
    description,
    headers: { 'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } } },
  });

/** 503 + Retry-After for a checkout or cancel without a definite answer; envelope and logging stay the global filter's. */
@Catch(CheckoutUnavailableError, CheckoutReadUnavailableError)
@Injectable()
export class CheckoutUnavailableFilter extends HttpExceptionFilter {
  private readonly retryAfter: string;

  constructor(logger: PinoLogger, cls: ClsService, config: ConfigService) {
    super(logger, cls, config);
    this.retryAfter = String(config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').retryAfterSec);
  }

  override catch(exception: CheckoutUnavailableError | CheckoutReadUnavailableError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().setHeader('Retry-After', this.retryAfter);
    super.catch(new ServiceUnavailableException(undefined, { cause: exception }), host);
  }
}
