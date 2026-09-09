import type { FinalizeOutcome } from '@modules/order/application/public/order-finalization.port';
import type { GatewayStatus } from '../ports/payment-gateway.port';

/** Cancelling is a user/admin decision about the order, never something a gateway can report. */
export type GatewayOutcome = Exclude<FinalizeOutcome, 'CANCELLED'>;

// A definite gateway answer beats the TTL; age decides only for PENDING and UNKNOWN.
export function mapGatewayStatusToOutcome(status: GatewayStatus, options: { pastTtl: boolean }): GatewayOutcome | null {
  if (status === 'PAID') return 'PAID';
  if (status === 'FAILED') return 'FAILED';
  return options.pastTtl ? 'EXPIRED' : null;
}
