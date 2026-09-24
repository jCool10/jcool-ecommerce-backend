import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from './configuration';

describe('id-service configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults the lease timings and bounds database queries', () => {
    vi.stubEnv('DB_QUERY_TIMEOUT_MS', undefined);
    const config = configuration();

    expect(config.lease).toMatchObject({
      ttlMs: 300_000,
      renewEveryMs: 60_000,
      quarantineMs: 10_000,
      fenceMarginMs: 15_000,
      maxFloorAheadMs: 15_000,
    });
    expect(config.database.queryTimeoutMs).toBe(2_000);
  });

  it('lets the floor tolerance follow a configured fence margin unless set itself', () => {
    vi.stubEnv('ID_LEASE_FENCE_MARGIN_MS', '20000');
    expect(configuration().lease.maxFloorAheadMs).toBe(20_000);

    vi.stubEnv('ID_LEASE_MAX_FLOOR_AHEAD_MS', '5000');
    expect(configuration().lease.maxFloorAheadMs).toBe(5_000);
  });

  it('loads a timing the way the validator accepted it', () => {
    vi.stubEnv('ID_LEASE_RENEW_EVERY_MS', '6e4');
    expect(configuration().lease.renewEveryMs).toBe(60_000);
  });
});
