import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';
import { HandlePaymentWebhookUseCase } from '../application/use-cases';

/**
 * `@Public()` — the caller is the payment gateway, authenticated by the HMAC signature over the raw
 * body, not by a bearer token. Both IP-keyed tiers are skipped because the gateway calls from a small
 * fixed set of IPs, a shape an IP limit reads as an attack, and a non-2xx only makes it retry harder —
 * dropping a legitimate retry loses the event. What protects this route is the signature check plus
 * idempotency on the event id, not a request count.
 *
 * The body is read as raw bytes (`req.rawBody`, enabled by `rawBody: true` in the bootstrap) and never
 * bound to a DTO, so the global ValidationPipe/JSON parser cannot re-serialize it and break the
 * signature. Only a verify failure is non-2xx (401); every accepted event returns 200.
 */
@ApiTags('payments')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly handleWebhook: HandlePaymentWebhookUseCase) {}

  @Public()
  // Both tiers must be named — bare `@SkipThrottle()` skips only `default`, leaving `account`.
  @SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
  @Post('payment')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Event accepted (processed | duplicate | skipped | ignored)' })
  @ApiUnauthorizedResponse({ description: 'Invalid signature or timestamp outside the tolerance window' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ status: string }> {
    const rawBody = req.rawBody;
    // No raw bytes means the request never went through the raw parser (wrong content-type, empty
    // body) — we can't verify a signature over nothing, so reject rather than trust it.
    if (!rawBody) {
      throw new UnauthorizedException('Missing webhook body');
    }

    const result = await this.handleWebhook.execute(rawBody, req.headers as Record<string, string>);
    if (result.outcome === 'rejected') {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return { status: result.outcome };
  }
}
