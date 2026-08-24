import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';

// UNWIRED SEAM — these report a hardcoded 0, not a measurement, so do not read a 0 here as
// "nothing pending". The relay now drains the table, which means a real backlog finally signals
// something is wrong — and that is exactly what these gauges still cannot show. Until `collect()`
// reads `WHERE published_at IS NULL` and the oldest row's age, a stalled relay is invisible here.
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
