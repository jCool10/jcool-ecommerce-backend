import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';

// UNWIRED SEAM — these report a hardcoded 0, not a measurement. The outbox table exists and is
// written on every checkout and every finalize, so the real backlog (`WHERE published_at IS NULL`)
// is now the whole table and grows without bound: there is no relay to drain it yet. Do not read a
// 0 here as "nothing pending". Wiring `collect()` to the real count + oldest-row age lands with the
// relay, which is also when a backlog first means something is wrong rather than merely unbuilt.
export const OUTBOX_BACKLOG_PENDING = 'outbox_backlog_pending';
export const OUTBOX_OLDEST_AGE_SECONDS = 'outbox_oldest_age_seconds';

export const OUTBOX_SEAM_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: OUTBOX_BACKLOG_PENDING,
    help: 'Unpublished outbox rows. NOT YET WIRED: always 0, regardless of table contents.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
  makeGaugeProvider({
    name: OUTBOX_OLDEST_AGE_SECONDS,
    help: 'Age of the oldest unpublished outbox row (seconds). NOT YET WIRED: always 0.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
];
