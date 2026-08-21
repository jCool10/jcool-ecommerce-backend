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
import { Public } from '@shared/rbac';
import { HandlePaymentWebhookUseCase } from '../application/use-cases';

/**
 * Gateway webhook sink. `@Public()` — the caller is the payment gateway, authenticated by the HMAC
 * signature over the raw body, not by a bearer token. `@SkipThrottle()` so a gateway's retry burst
 * can't trip the rate limiter into 429s (a non-2xx only makes it retry harder).
 *
 * The body is read as raw bytes (`req.rawBody`, enabled by `rawBody: true` in the bootstrap) and
 * never bound to a DTO, so the global ValidationPipe/JSON parser can't re-serialize it and break
 * the signature. Only a verify failure is non-2xx (401); every accepted event — including a
 * duplicate or a skipped one — returns 200 so the gateway stops redelivering.
 */
@ApiTags('payments')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly handleWebhook: HandlePaymentWebhookUseCase) {}

  @Public()
  @SkipThrottle()
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
