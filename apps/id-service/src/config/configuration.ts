import { hostname } from 'node:os';
import { appConfig, observabilityConfig } from '@jcool/platform/config';

// Railway's replica id is a UUID with no order to it, so the host and pid ride along for whoever reads
// the keyspace while debugging. Nothing identifies a holder by this string: its etcd lease does.
function leaseHolder(): string {
  return [process.env.RAILWAY_REPLICA_ID ?? 'local', hostname(), process.pid].join('/');
}

// Read the way the validator reads them: parseInt would pass '6e4' as 60000 and then load it as 6.
function msEnv(raw: string | undefined, fallback: number): number {
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

export const DEFAULT_ETCD_KEY_PREFIX = '/jcool/id-service/';

/** Shared with the floor-lift CLI, which runs outside Nest. */
export function etcdConfig() {
  return {
    endpoints: (process.env.ETCD_ENDPOINTS ?? '')
      .split(',')
      .map((endpoint) => endpoint.trim())
      .filter(Boolean),
    keyPrefix: process.env.ETCD_KEY_PREFIX || DEFAULT_ETCD_KEY_PREFIX,
    // A renew stuck on an etcd that stopped answering would outlive the fence; bounded by default.
    requestTimeoutMs: msEnv(process.env.ETCD_REQUEST_TIMEOUT_MS, 2_000),
  };
}

export type EtcdConfig = ReturnType<typeof etcdConfig>;
export type LeaseConfig = ReturnType<typeof configuration>['lease'];

export default function configuration() {
  const fenceMarginMs = msEnv(process.env.ID_LEASE_FENCE_MARGIN_MS, 15_000);
  return {
    ...appConfig(),
    ...observabilityConfig({ serviceName: 'jcool-id-service' }),
    etcd: etcdConfig(),
    lease: {
      holder: leaseHolder(),
      ttlMs: msEnv(process.env.ID_LEASE_TTL_MS, 300_000),
      renewEveryMs: msEnv(process.env.ID_LEASE_RENEW_EVERY_MS, 60_000),
      fenceMarginMs,
      maxFloorAheadMs: msEnv(process.env.ID_LEASE_MAX_FLOOR_AHEAD_MS, fenceMarginMs),
    },
  };
}
