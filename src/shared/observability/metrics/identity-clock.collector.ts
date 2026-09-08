import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import type { UuidV8Generator } from '@shared/identity';

// The two ways the host clock spoils ids, neither of which surfaces as an application error: drift
// (ids carry a jumped timestamp) and stalls (mints refused outright).
export const ID_CLOCK_DRIFT_MS = 'id_clock_drift_ms';
export const ID_CLOCK_STALL_TOTAL = 'id_clock_stall_total';

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
];
