import { v7 as uuidv7 } from 'uuid';
import type {
  CreateSessionInput,
  GatewaySession,
  PaymentGatewayPort,
  VerifiedEvent,
} from '../../application/ports/payment-gateway.port';
import { signStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

/**
 * Deterministic gateway double for tests and local dev. It signs and verifies for real, sharing
 * hmac-signature.ts with the Stripe adapter, so the scheme can never drift — this is real
 * behavior, not a mock of our own domain. `sign` lets integration tests build validly /
 * invalidly / expired-signed webhook fixtures offline (no network, no Stripe account).
 */
export class FakeSignerGatewayAdapter implements PaymentGatewayPort {
  // Emulates the Stripe scheme, so a payment it creates is recorded under the same provider key.
  readonly provider = 'stripe';

  constructor(
    private readonly secret: string,
    private readonly toleranceSec = 300,
  ) {}

  /** Build a Stripe-style signature header for `rawBody` at `timestampSec` (test fixture helper). */
  sign(rawBody: Buffer | string, timestampSec: number): string {
    return signStripeStyle(this.secret, timestampSec, rawBody);
  }

  createSession(input: CreateSessionInput): Promise<GatewaySession> {
    void input;
    const sessionId = `cs_fake_${uuidv7().replace(/-/g, '')}`;
    return Promise.resolve({
      providerSessionId: sessionId,
      redirectUrl: `https://fake.gateway.test/pay/${sessionId}`,
    });
  }

  verifyAndParseEvent(rawBody: Buffer, headers: Record<string, string>): VerifiedEvent {
    return verifyAndParseStripeEvent({
      secret: this.secret,
      toleranceSec: this.toleranceSec,
      rawBody,
      headers,
    });
  }
}
