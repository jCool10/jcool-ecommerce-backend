import type { Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { toError } from '@jcool/kernel';
import { DOMAIN_EVENTS_CONSUMER } from '../queue/queue.constants';
import { ConsumerRetryStore } from './consumer-retry.store';

const LOG_CONTEXT = 'RetryBacklogCollector';

export const MESSAGING_RETRY_PENDING = 'messaging_retry_pending';
export const MESSAGING_DEAD_LETTERS = 'messaging_dead_letters';

// Same reasoning as the outbox backlog collector: a statement stuck behind a lock must not hang the
// scrape or hold a pool client past it.
const SCRAPE_TIMEOUT_MS = 2_000;

type CountsByConsumer = Map<string, number>;

interface RetryBacklog {
  pending: CountsByConsumer;
  dead: CountsByConsumer;
}

interface PendingRead {
  backlog: Promise<RetryBacklog>;
  reported: boolean;
}

// Both gauges collect in the same scrape, so they share the one in-flight query.
let pending: PendingRead | null = null;

function readBacklog(store: ConsumerRetryStore, logger: PinoLogger): Promise<RetryBacklog | null> {
  const read = (pending ??= {
    backlog: queryBacklog(store).finally(() => {
      pending = null;
    }),
    reported: false,
  });
  return bounded(read, logger);
}

// Null on any failure, so one bad read keeps the last values instead of failing the whole /metrics.
async function bounded(read: PendingRead, logger: PinoLogger): Promise<RetryBacklog | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read.backlog,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`query exceeded ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (caught) {
    if (!read.reported) {
      read.reported = true;
      logger.warn({ context: LOG_CONTEXT, err: toError(caught) }, 'retry backlog scrape failed');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryBacklog(store: ConsumerRetryStore): Promise<RetryBacklog> {
  const counts = await store.countByStatus();
  // Every consumer seen gets both series, and domain-events always has them, so a drained consumer
  // reads 0 rather than vanishing from the alert's view.
  const consumers = new Set([DOMAIN_EVENTS_CONSUMER, ...counts.map((row) => row.consumer)]);
  const backlog: RetryBacklog = { pending: new Map(), dead: new Map() };
  for (const consumer of consumers) {
    backlog.pending.set(consumer, 0);
    backlog.dead.set(consumer, 0);
  }
  for (const { consumer, status, rows } of counts) backlog[status].set(consumer, rows);
  return backlog;
}

async function observe(
  gauge: Gauge<'consumer'>,
  store: ConsumerRetryStore,
  logger: PinoLogger,
  pick: (backlog: RetryBacklog) => CountsByConsumer,
): Promise<void> {
  const backlog = await readBacklog(store, logger);
  if (!backlog) return;
  gauge.reset();
  for (const [consumer, rows] of pick(backlog)) gauge.set({ consumer }, rows);
}

export const RETRY_BACKLOG_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: MESSAGING_RETRY_PENDING,
    help: 'Failed deliveries waiting in consumer_retries for their next attempt.',
    labelNames: ['consumer'],
    inject: [ConsumerRetryStore, PinoLogger],
    collect(this: Gauge<'consumer'>, store: ConsumerRetryStore, logger: PinoLogger) {
      return observe(this, store, logger, (backlog) => backlog.pending);
    },
  }),
  makeGaugeProvider({
    name: MESSAGING_DEAD_LETTERS,
    help: 'Dead letters in consumer_retries waiting for a replay or a manual decision.',
    labelNames: ['consumer'],
    inject: [ConsumerRetryStore, PinoLogger],
    collect(this: Gauge<'consumer'>, store: ConsumerRetryStore, logger: PinoLogger) {
      return observe(this, store, logger, (backlog) => backlog.dead);
    },
  }),
];
