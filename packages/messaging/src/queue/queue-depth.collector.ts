import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, type Provider } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { toError } from '@jcool/kernel';
import { createCollectorBinding } from '@jcool/platform/metrics';
import { MESSAGING_CONSUMERS, MESSAGING_QUEUES } from '../messaging.tokens';
import type { Consumers } from './queue-definition';

const LOG_CONTEXT = 'QueueDepthCollector';

// Consumer lag shows nowhere else: the relay keeps publishing, so the outbox stays empty, and a
// payment.authorized stuck here never reaches its saga.
export const MESSAGING_QUEUE_JOBS = 'messaging_queue_jobs';
export const MESSAGING_QUEUE_OLDEST_WAITING_SECONDS = 'messaging_queue_oldest_waiting_seconds';

const SCRAPE_TIMEOUT_MS = 2_000;
const WARN_EVERY_MS = 60_000;
const STATES = ['wait', 'prioritized', 'active', 'delayed'] as const;

interface ScrapeSource {
  queues: Queue[];
  logger: PinoLogger;
  lastWarnAt: number;
}

interface QueueDepth {
  queue: string;
  jobs: Record<(typeof STATES)[number], number>;
  oldestWaitingSeconds: number;
}

const binding = createCollectorBinding<ScrapeSource>();
let pending: Promise<QueueDepth[]> | null = null;

async function depthOf(queue: Queue): Promise<QueueDepth> {
  const [counts, [oldest]] = await Promise.all([queue.getJobCounts(...STATES), queue.getJobs(['wait'], 0, 0, true)]);
  return {
    queue: queue.name,
    jobs: Object.fromEntries(STATES.map((state) => [state, counts[state] ?? 0])) as QueueDepth['jobs'],
    oldestWaitingSeconds: oldest ? Math.max(0, (Date.now() - oldest.timestamp) / 1000) : 0,
  };
}

/** Null on failure: the gauges hold their last sample, Redis has its own health signal. */
async function readDepths(source: ScrapeSource): Promise<QueueDepth[] | null> {
  const read = (pending ??= Promise.all(source.queues.map(depthOf)).finally(() => {
    pending = null;
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`queue read exceeded ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const now = Date.now();
    if (now - source.lastWarnAt >= WARN_EVERY_MS) {
      source.lastWarnAt = now;
      source.logger.warn({ err: toError(error) }, 'queue depth scrape failed, gauges hold their last sample');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function observe(gauge: Gauge<string>, write: (gauge: Gauge<string>, depth: QueueDepth) => void) {
  const source = binding.current();
  if (!source) {
    gauge.reset();
    return;
  }
  const depths = await readDepths(source);
  if (!depths) return;
  gauge.reset();
  for (const depth of depths) write(gauge, depth);
}

/** The queues this process consumes. Not their DLQs: nothing consumes those by design, so they only grow. */
@Injectable()
export class QueueDepthCollectorBinding implements OnModuleInit, OnModuleDestroy {
  private readonly source: ScrapeSource;

  constructor(
    @Inject(MESSAGING_QUEUES) queues: ReadonlyMap<string, Queue>,
    @Inject(MESSAGING_CONSUMERS) consumers: Consumers,
    logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    const consumed = [...consumers.keys()].map((name) => {
      const queue = queues.get(name);
      if (!queue) throw new Error(`consumed queue ${name} was never opened`);
      return queue;
    });
    this.source = { queues: consumed, logger, lastWarnAt: -Infinity };
  }

  onModuleInit(): void {
    binding.bind(this.source);
  }

  onModuleDestroy(): void {
    binding.unbind(this.source);
  }
}

export const QUEUE_DEPTH_COLLECTOR_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: MESSAGING_QUEUE_JOBS,
    help: 'Jobs in a consumed BullMQ queue, by state.',
    labelNames: ['queue', 'state'],
    collect(this: Gauge<string>) {
      return observe(this, (gauge, { queue, jobs }) => {
        for (const state of STATES) gauge.set({ queue, state }, jobs[state]);
      });
    },
  }),
  makeGaugeProvider({
    name: MESSAGING_QUEUE_OLDEST_WAITING_SECONDS,
    help: 'Seconds the oldest job in wait has existed, per consumed BullMQ queue (0 when none waits).',
    labelNames: ['queue'],
    collect(this: Gauge<string>) {
      return observe(this, (gauge, { queue, oldestWaitingSeconds }) => gauge.set({ queue }, oldestWaitingSeconds));
    },
  }),
  QueueDepthCollectorBinding,
];
