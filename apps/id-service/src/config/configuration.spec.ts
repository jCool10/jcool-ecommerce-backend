import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from './configuration';

describe('id-service configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults the lease timings and bounds etcd calls', () => {
    vi.stubEnv('ETCD_REQUEST_TIMEOUT_MS', undefined);
    vi.stubEnv('ETCD_KEY_PREFIX', undefined);
    const config = configuration();

    expect(config.lease).toMatchObject({
      ttlMs: 300_000,
      renewEveryMs: 60_000,
      fenceMarginMs: 15_000,
      maxFloorAheadMs: 15_000,
    });
    expect(config.etcd).toMatchObject({ keyPrefix: '/jcool/id-service/', requestTimeoutMs: 2_000 });
  });

  it('reads every etcd endpoint from a comma-separated list', () => {
    vi.stubEnv('ETCD_ENDPOINTS', 'http://etcd-a:2379, http://etcd-b:2379,');
    expect(configuration().etcd.endpoints).toEqual(['http://etcd-a:2379', 'http://etcd-b:2379']);
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
