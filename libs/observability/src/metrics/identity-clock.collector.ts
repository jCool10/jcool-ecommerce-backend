import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import type { UuidV8Generator } from '@shared/identity';
import { activeLease } from '@shared/identity/lease/active-lease';

// The two ways the host clock spoils ids, neither of which surfaces as an application error: drift
// (ids carry a jumped timestamp) and stalls (mints refused outright).
export const ID_CLOCK_DRIFT_MS = 'id_clock_drift_ms';
export const ID_CLOCK_STALL_TOTAL = 'id_clock_stall_total';

// Which node this replica holds, and how the lease behind it is faring. `identity_lease_node_id` is
// the series that proves two replicas are not minting under one id — the whole point of the lease.
export const IDENTITY_LEASE_NODE_ID = 'identity_lease_node_id';
export const IDENTITY_LEASE_AGE_SECONDS = 'identity_lease_age_seconds';
export const IDENTITY_LEASE_RENEWAL_FAILURE_TOTAL = 'identity_lease_renewal_failure_total';
export const IDENTITY_LEASE_LOST_TOTAL = 'identity_lease_lost_total';

// Module-level rather than captured in the collect closures: the registry get-or-creates a metric by
// name, so a closure over an injected generator would pin the FIRST app built in the process and
// report one nothing mints through (same hazard as `outbox-backlog.collector.ts`).
let bound: UuidV8Generator | null = null;

export function bindIdentityClockMetrics(generator: UuidV8Generator): void {
  bound = generator;
}

/**
 * Guarded on identity: where a process builds a second app before closing the first, the older
 * app's shutdown must not tear down the newer app's binding.
 */
export function unbindIdentityClockMetrics(generator: UuidV8Generator): void {
  if (bound === generator) bound = null;
}

export const IDENTITY_CLOCK_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: ID_CLOCK_DRIFT_MS,
    help: 'Milliseconds of one-way wall-clock catch-up the id generator has absorbed since it was constructed. Never decreases; a resumed host resumes with the whole suspended gap here.',
    collect(this: Gauge<string>) {
      // Withdrawn rather than left at prom-client's seeded 0: unbound means nothing is measuring,
      // and a 0 on a dashboard reads as a healthy clock.
      if (bound) this.set(bound.clockDriftMs);
      else this.remove();
    },
  }),
  makeCounterProvider({
    name: ID_CLOCK_STALL_TOTAL,
    help: 'Times the generator refused to mint because the clock stopped advancing (each one answered a request with 503).',
    // Left at 0 while unbound, unlike the gauge: 0 stalls says the same thing either way, and a
    // counter that appears mid-scrape gives `increase()` no baseline.
    collect(this: Counter<string>) {
      if (!bound) return;
      // Mirrors a value the generator owns, so the total stays monotonic for as long as one stays
      // bound. Rebinding restarts at zero and `increase()` reads that as a counter reset — only a
      // test process that builds a second app ever sees it.
      this.reset();
      this.inc(bound.stallCount);
    },
  }),
  makeGaugeProvider({
    name: IDENTITY_LEASE_NODE_ID,
    help: 'Node id this process holds under its lease. Withdrawn while no lease is held — a fenced or unleased process must not report a node it may not mint under.',
    collect(this: Gauge<string>) {
      const lease = activeLease();
      if (lease?.isValid && lease.node !== null) this.set(lease.node);
      else this.remove();
    },
  }),
  makeGaugeProvider({
    name: IDENTITY_LEASE_AGE_SECONDS,
    help: 'Seconds since the lease was last renewed. Climbing toward the TTL means the renewal loop is starving, which fences the process when the deadline elapses.',
    collect(this: Gauge<string>) {
      const lease = activeLease();
      if (lease?.isValid) this.set(lease.ageSeconds);
      else this.remove();
    },
  }),
  makeCounterProvider({
    name: IDENTITY_LEASE_RENEWAL_FAILURE_TOTAL,
    help: 'Renewals that failed on transport, not on a steal. These do not fence — only the send-anchored deadline does — so a rising rate is an early warning, not an outage.',
    collect(this: Counter<string>) {
      const lease = activeLease();
      if (!lease) return;
      this.reset();
      this.inc(lease.renewalFailureCount);
    },
  }),
  makeCounterProvider({
    name: IDENTITY_LEASE_LOST_TOTAL,
    help: 'Times this process was fenced because its node id was taken. Non-zero means two processes believed they held one node.',
    collect(this: Counter<string>) {
      const lease = activeLease();
      if (!lease) return;
      this.reset();
      this.inc(lease.lostTotal);
    },
  }),
];
