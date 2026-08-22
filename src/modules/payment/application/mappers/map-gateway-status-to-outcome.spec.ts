import { describe, expect, it } from 'vitest';
import { mapGatewayStatusToOutcome } from './map-gateway-status-to-outcome';

describe('mapGatewayStatusToOutcome', () => {
  it('settles a paid session whatever its age', () => {
    expect(mapGatewayStatusToOutcome('PAID', { pastTtl: false })).toBe('PAID');
    expect(mapGatewayStatusToOutcome('PAID', { pastTtl: true })).toBe('PAID');
  });

  it('fails a gateway-side failed session whatever its age', () => {
    expect(mapGatewayStatusToOutcome('FAILED', { pastTtl: false })).toBe('FAILED');
    expect(mapGatewayStatusToOutcome('FAILED', { pastTtl: true })).toBe('FAILED');
  });

  it('leaves an undecided session alone while it is still within the order TTL', () => {
    expect(mapGatewayStatusToOutcome('PENDING', { pastTtl: false })).toBeNull();
    expect(mapGatewayStatusToOutcome('UNKNOWN', { pastTtl: false })).toBeNull();
  });

  it('expires an undecided session once it is past the order TTL, so the stock hold is freed', () => {
    expect(mapGatewayStatusToOutcome('PENDING', { pastTtl: true })).toBe('EXPIRED');
    expect(mapGatewayStatusToOutcome('UNKNOWN', { pastTtl: true })).toBe('EXPIRED');
  });
});
