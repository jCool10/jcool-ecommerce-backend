import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';

// SEAM (BF#4). The transactional outbox table does not exist yet, so these gauges report a
// truthful 0 rather than reading a phantom table or fabricating a number. When the outbox
// lands, wire `collect()` to `SELECT count(*) ... WHERE published_at IS NULL` (partial index)
// and to the oldest-row age. Kept isolated here so the seam is obvious and easy to complete.
export const OUTBOX_BACKLOG_PENDING = 'outbox_backlog_pending';
export const OUTBOX_OLDEST_AGE_SECONDS = 'outbox_oldest_age_seconds';

export const OUTBOX_SEAM_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: OUTBOX_BACKLOG_PENDING,
    help: 'Unpublished outbox rows. SEAM: 0 until the BF#4 outbox table exists.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
  makeGaugeProvider({
    name: OUTBOX_OLDEST_AGE_SECONDS,
    help: 'Age of the oldest unpublished outbox row (seconds). SEAM: 0 until BF#4.',
    collect(this: Gauge<string>) {
      this.set(0);
    },
  }),
];
