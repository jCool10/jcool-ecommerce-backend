import { Injectable, NotImplementedException } from '@nestjs/common';
import type { GatewaySession, PaymentGatewayPort, VerifiedEvent } from '../../application/ports/payment-gateway.port';

/**
 * Interface-only seam for the Vietnam-domestic gateway. Kept unimplemented so the port stays
 * swappable without coding a second provider this iteration. A real SePay/VietQR impl verifies
 * with an `Authorization: Apikey` header (no body HMAC), so it must rely on webhook_events
 * dedup — not a timestamp window — for replay defense.
 */
@Injectable()
export class SepayGatewayAdapter implements PaymentGatewayPort {
  readonly provider = 'sepay';

  createSession(): Promise<GatewaySession> {
    throw new NotImplementedException('SePay/VietQR gateway not yet implemented');
  }

  verifyAndParseEvent(): VerifiedEvent {
    throw new NotImplementedException('SePay/VietQR gateway not yet implemented');
  }
}
