import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  CreateSessionInput,
  GatewaySession,
  PaymentGatewayPort,
  VerifiedEvent,
} from '../../application/ports/payment-gateway.port';
import { verifyAndParseStripeEvent } from './hmac-signature';

export interface StripeGatewayOptions {
  webhookSecret?: string;
  toleranceSec: number;
}

/**
 * Primary coded gateway. Webhook verification is the fully-implemented BF#3 core (HMAC-SHA256 +
 * timestamp tolerance + replay defense via hmac-signature.ts). `createSession` is network-free:
 * the live Stripe SDK call is the production seam, kept out so the coded path needs no live key
 * and is never exercised against Stripe in offline tests.
 */
@Injectable()
export class StripeGatewayAdapter implements PaymentGatewayPort {
  readonly provider = 'stripe';
  private readonly webhookSecret: string;
  private readonly toleranceSec: number;

  constructor(options: StripeGatewayOptions) {
    // Fail-fast on the real path: a missing/blank webhook secret would silently accept forged
    // events, so refuse to construct instead of booting a gateway that can't verify anything.
    if (!options.webhookSecret || options.webhookSecret.trim() === '') {
      throw new Error('PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=stripe');
    }
    // A non-finite/negative window would make the replay check `Math.abs(...) > NaN` always false,
    // silently disabling replay defense — as dangerous as a missing secret, so fail-fast too.
    if (!Number.isFinite(options.toleranceSec) || options.toleranceSec < 0) {
      throw new Error('PAYMENT_WEBHOOK_TOLERANCE_SEC must be a non-negative number');
    }
    this.webhookSecret = options.webhookSecret;
    this.toleranceSec = options.toleranceSec;
  }

  createSession(input: CreateSessionInput): Promise<GatewaySession> {
    // Production seam: stripe.checkout.sessions.create({ ... }, { idempotencyKey: input.idempotencyKey }).
    // The generated handle stands in for cs_... and flows onto Payment.providerSessionId.
    void input;
    const sessionId = `cs_test_${uuidv7().replace(/-/g, '')}`;
    return Promise.resolve({
      providerSessionId: sessionId,
      redirectUrl: `https://checkout.stripe.test/pay/${sessionId}`,
    });
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return verifyAndParseStripeEvent({
      secret: this.webhookSecret,
      toleranceSec: this.toleranceSec,
      rawBody,
      headers,
    });
  }
}
