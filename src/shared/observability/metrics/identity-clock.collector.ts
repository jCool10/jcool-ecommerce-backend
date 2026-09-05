import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import type { UuidV8Generator } from '@shared/identity';

// The two ways the host clock can spoil ids, and neither is visible anywhere else: drift says every
// id minted from here on carries a timestamp that jumped, stalls say the clock stopped and mints are
// being refused outright. Both are the host's fault, so neither shows up as an application error.
export const ID_CLOCK_DRIFT_MS = 'id_clock_drift_ms';
export const ID_CLOCK_STALL_TOTAL = 'id_clock_stall_total';

// The registry get-or-creates a metric by name, so a collect closure that captured an injected
// generator would keep the FIRST app built in this process for the life of it and report a generator
// nothing is minting through (`outbox-backlog.collector.ts` documents the same hazard from the other
// side). Holding the newest generator instead means the app that booted last is the one measured —
// the app under test in an e2e run, and the only app there is in production.
let bound: UuidV8Generator | null = null;

export function bindIdentityClockMetrics(generator: UuidV8Generator): void {
  bound = generator;
}

/**
 * Guarded on identity rather than clearing unconditionally: in a process that builds a second app
 * before closing the first, the older app's shutdown must not tear down the newer app's binding.
 * Releasing at all is what keeps an absent series meaning "nothing is measuring" — a closed app
 * whose generator stayed bound would keep reporting a drift figure nothing is minting against.
 */
export function unbindIdentityClockMetrics(generator: UuidV8Generator): void {
  if (bound === generator) bound = null;
}

export const IDENTITY_CLOCK_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: ID_CLOCK_DRIFT_MS,
    help: 'Milliseconds of one-way wall-clock catch-up the id generator has absorbed since it was constructed. Never decreases; a resumed host resumes with the whole suspended gap here.',
    collect(this: Gauge<string>) {
      // Withdrawn rather than left at the 0 prom-client seeds it with: unbound means nothing is
      // measuring, and a 0 reads as "the clock is healthy" — which is the exact confusion this
      // series exists to prevent. An absent series is also what shows up if the generator ever stops
      // being wired at boot, instead of a flat line that looks like good news.
      if (bound) this.set(bound.clockDriftMs);
      else this.remove();
    },
  }),
  makeCounterProvider({
    name: ID_CLOCK_STALL_TOTAL,
    help: 'Times the generator refused to mint because the clock stopped advancing (each one answered a request with 503).',
    // Left at 0 while unbound, unlike the gauge above: 0 stalls is the same statement whether or not
    // a generator exists, and a counter that appears mid-scrape gives `increase()` no baseline.
    collect(this: Counter<string>) {
      if (!bound) return;
      // Mirroring a value the generator owns rather than accumulating our own, so the exported total
      // is monotonic for as long as one generator stays bound — which is the process lifetime in
      // production. Rebinding starts a new generator at zero, and `increase()` reads that as a
      // counter reset; only a test process that builds a second app ever sees it.
      this.reset();
      this.inc(bound.stallCount);
    },
  }),
];
