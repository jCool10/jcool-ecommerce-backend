import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CANCEL_OUTCOME_STATUS,
  CAPTURE_OUTCOME_STATUS,
  PAYMENTS_PREFIX,
  SESSION_OUTCOME_STATUS,
  type PaymentStatusResponse,
} from '@jcool/internal-contracts';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { CallerTokenGuard, InternalCallers } from '@jcool/platform/internal-api';
import {
  PAYMENT_PARTICIPANT,
  PaymentGatewayError,
  type PaymentParticipant,
} from '../../application/public/payment-participant.port';
import { OpenSessionDto, PaymentStatusDto } from './dto';
import { ProviderUnavailableFilter, RETRY_AFTER_SEC } from './provider-unavailable.filter';

/**
 * The checkout saga's side of payment. Every route is idempotent per order through `payment_orders`,
 * so a retry after a lost answer is safe. Business outcomes are a 2xx or a 409 carrying `outcome`;
 * anything the participant throws is a 503 to retry, one naming Stripe when Stripe is the cause.
 */
@ApiExcludeController()
@UseGuards(CallerTokenGuard)
@UseFilters(ProviderUnavailableFilter)
@InternalCallers('api', 'order-service')
@Controller(PAYMENTS_PREFIX)
export class PaymentsController {
  constructor(@Inject(PAYMENT_PARTICIPANT) private readonly participant: PaymentParticipant) {}

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(
    @Body() { orderIds }: PaymentStatusDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentStatusResponse> {
    const statuses = await this.orRetry(res, () => this.participant.statusOf(orderIds));
    return { statuses: Object.fromEntries(statuses) };
  }

  // `@Res()` without passthrough: Nest would otherwise reset the status to the route's default.
  @Post(':orderId/session')
  async openSession(
    @Param('orderId', ParseSnowflakeIdPipe) orderId: string,
    @Body() { amountMinor, currency, expiresAt }: OpenSessionDto,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.orRetry(res, () =>
      this.participant.openSession({ orderId, amountMinor, currency, expiresAt: new Date(expiresAt) }),
    );
    res.status(SESSION_OUTCOME_STATUS[result.outcome]).json(result);
  }

  @Post(':orderId/capture')
  async capture(@Param('orderId', ParseSnowflakeIdPipe) orderId: string, @Res() res: Response): Promise<void> {
    const outcome = await this.orRetry(res, () => this.participant.capture({ orderId }));
    res.status(CAPTURE_OUTCOME_STATUS[outcome]).json({ outcome });
  }

  @Post(':orderId/cancel')
  async cancel(@Param('orderId', ParseSnowflakeIdPipe) orderId: string, @Res() res: Response): Promise<void> {
    const outcome = await this.orRetry(res, () => this.participant.cancel({ orderId }));
    res.status(CANCEL_OUTCOME_STATUS[outcome]).json({ outcome });
  }

  private async orRetry<T>(res: Response, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      res.setHeader('Retry-After', RETRY_AFTER_SEC);
      if (error instanceof PaymentGatewayError) throw error;
      throw new ServiceUnavailableException(undefined, { cause: error });
    }
  }
}
