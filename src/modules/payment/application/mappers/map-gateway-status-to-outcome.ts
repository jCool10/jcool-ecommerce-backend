import type { FinalizeOutcome } from '@modules/order/application/use-cases';
import type { GatewayStatus } from '../ports/payment-gateway.port';

/**
 * The sweep's counterpart to `mapPaymentToOrderOutcome`. A definite answer from the gateway beats the
 * TTL: PAID settles the order however old it is, because the money moved. Age decides only when the
 * gateway has no outcome (PENDING) or cannot give one (UNKNOWN).
 */
export function mapGatewayStatusToOutcome(
  status: GatewayStatus,
  options: { pastTtl: boolean },
): FinalizeOutcome | null {
  if (status === 'PAID') return 'PAID';
  if (status === 'FAILED') return 'FAILED';
  return options.pastTtl ? 'EXPIRED' : null;
}
