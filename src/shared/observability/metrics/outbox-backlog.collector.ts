import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';

// Seam: the transactional outbox table doesn't exist yet, so these gauges report a truthful 0.
// When it lands, wire `collect()` to a `WHERE published_at IS NULL` count and the oldest-row age.
export const OUTBOX_BACKLOG_PENDING = 'outbox_backlog_pending';
export const OUTBOX_OLDEST_AGE_SECONDS = 'outbox_oldest_age_seconds';

export const OUTBOX_SEAM_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: OUTBOX_BACKLOG_PENDING,
    help: 'Unpublished outbox rows. Seam: 0 until the outbox table exists.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
  makeGaugeProvider({
    name: OUTBOX_OLDEST_AGE_SECONDS,
    help: 'Age of the oldest unpublished outbox row (seconds). Seam: 0 until the outbox table exists.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
];
