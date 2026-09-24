import { describe, expect, it } from 'vitest';
import type { GatewayStatus } from '../ports/payment-gateway.port';
import { mapGatewayStatusToOutcome } from './map-gateway-status-to-outcome';

describe('mapGatewayStatusToOutcome', () => {
  it('lets a definite answer beat the TTL, and age decide only an undecided session', () => {
    const statuses: GatewayStatus[] = ['PAID', 'FAILED', 'PENDING', 'UNKNOWN'];
    const table = (pastTtl: boolean) => statuses.map((status) => mapGatewayStatusToOutcome(status, { pastTtl }));

    expect(table(false)).toEqual(['PAID', 'FAILED', null, null]);
    expect(table(true)).toEqual(['PAID', 'FAILED', 'EXPIRED', 'EXPIRED']);
  });
});
