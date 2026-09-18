import { hostname } from 'node:os';
import { appConfig, databaseConfig, observabilityConfig, parseIntOr } from '@jcool/platform/config';

// Railway's replica id is a UUID with no order to it, so the host and pid ride along for whoever reads
// the table while debugging. Nothing identifies a holder by this string: the lease generation does.
function leaseHolder(): string {
  return [process.env.RAILWAY_REPLICA_ID ?? 'local', hostname(), process.pid].join('/');
}

// Read the way the validator reads them: parseInt would pass '6e4' as 60000 and then load it as 6.
function msEnv(raw: string | undefined, fallback: number): number {
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

export type LeaseConfig = ReturnType<typeof configuration>['lease'];

export default function configuration() {
  const { database } = databaseConfig();
  const fenceMarginMs = msEnv(process.env.ID_LEASE_FENCE_MARGIN_MS, 15_000);
  return {
    ...appConfig(),
    ...observabilityConfig({ serviceName: 'jcool-id-service' }),
    // A renew stuck on a database that stopped answering would outlive the fence; bounded by default.
    database: { ...database, queryTimeoutMs: parseIntOr(process.env.DB_QUERY_TIMEOUT_MS, 2_000) },
    lease: {
      holder: leaseHolder(),
      ttlMs: msEnv(process.env.ID_LEASE_TTL_MS, 300_000),
      renewEveryMs: msEnv(process.env.ID_LEASE_RENEW_EVERY_MS, 60_000),
      quarantineMs: msEnv(process.env.ID_LEASE_QUARANTINE_MS, 10_000),
      fenceMarginMs,
      maxFloorAheadMs: msEnv(process.env.ID_LEASE_MAX_FLOOR_AHEAD_MS, fenceMarginMs),
    },
  };
}
