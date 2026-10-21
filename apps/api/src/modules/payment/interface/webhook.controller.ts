import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { Public } from '@jcool/platform/rbac';
import { PaymentGatewayError } from '../application/ports/payment-gateway.port';
import { HandlePaymentWebhookUseCase, WebhookRetryLaterError } from '../application/use-cases';

/**
 * `@Public()` — the caller is the payment gateway, authenticated by the HMAC signature over the raw
 * body, not by a bearer token. Both IP-keyed tiers are skipped because the gateway calls from a small
 * fixed set of IPs, a shape an IP limit reads as an attack, and a non-2xx only makes it retry harder —
 * dropping a legitimate retry loses the event. What protects this route is the signature check plus
 * idempotency on the event id, not a request count.
 *
 * The body is read as raw bytes (`req.rawBody`, enabled by `rawBody: true` in the bootstrap) and never
 * bound to a DTO, so the global ValidationPipe/JSON parser cannot re-serialize it and break the
 * signature. A verify failure is a 401, and a participant event Stripe could not
 * confirm yet a 503; every accepted event returns 200.
 */
@ApiTags('payments')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly handlePaymentWebhook: HandlePaymentWebhookUseCase) {}

  @Public()
  // Both tiers must be named — bare `@SkipThrottle()` skips only `default`, leaving `account`. The
  // `user` tier is charged only by UserThrottlerGuard, which this @Public() route does not carry.
  @SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
  @Post('payment')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Event accepted (processed | duplicate | skipped | ignored)' })
  @ApiUnauthorizedResponse({ description: 'Invalid signature or timestamp outside the tolerance window' })
  @ApiServiceUnavailableResponse({ description: 'Stripe could not confirm the event yet; redeliver later' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ status: string }> {
    const rawBody = req.rawBody;
    // No raw bytes means the request never went through the raw parser (wrong content-type, empty
    // body) — we can't verify a signature over nothing, so reject rather than trust it.
    if (!rawBody) {
      throw new UnauthorizedException('Missing webhook body');
    }

    const result = await this.handlePaymentWebhook
      .execute(rawBody, req.headers as Record<string, string>)
      .catch((error: unknown) => {
        // Nothing was logged for the event, so Stripe's redelivery gets a clean run. The cause stays
        // in our logs, never in the response.
        if (error instanceof PaymentGatewayError || error instanceof WebhookRetryLaterError) {
          throw new ServiceUnavailableException('Payment provider is temporarily unavailable', { cause: error });
        }
        throw error;
      });
    if (result.outcome === 'rejected') {
      // The cause is logged, not sent: it tells a wrong secret apart from a clock or replay problem.
      throw new UnauthorizedException('Invalid webhook signature', {
        cause: new Error(result.reason),
        description: 'Unauthorized',
      });
    }
    return { status: result.outcome };
  }
}
