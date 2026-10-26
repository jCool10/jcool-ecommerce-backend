import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client } from '@temporalio/client';
import { optionalTsToMs } from '@temporalio/common/lib/time';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { PinoLogger } from 'nestjs-pino';
import type { Gauge } from 'prom-client';
import { toError } from '@jcool/kernel';
import { createCollectorBinding } from '@jcool/platform/metrics';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { CheckoutStep } from '../../domain/checkout-saga';
import { checkoutDeadlineKey, checkoutStepKey } from './checkout-saga.contract';
import { checkoutSagaRunsOf } from './temporal-checkout-saga.engine';
import { TEMPORAL_CLIENT } from './temporal.providers';

const LOG_CONTEXT = 'CheckoutSagaCollector';

export const CHECKOUT_SAGAS_OPEN = 'checkout_sagas_open';
export const CHECKOUT_SAGA_OVERDUE = 'checkout_saga_overdue';
export const CHECKOUT_SAGA_CLOSED_ABNORMALLY = 'checkout_saga_closed_abnormally';
export const CHECKOUT_SAGA_TASK_QUEUE_POLLERS = 'checkout_saga_task_queue_pollers';
export const CHECKOUT_SAGA_TASK_QUEUE_BACKLOG_AGE_SECONDS = 'checkout_saga_task_queue_backlog_age_seconds';
export const CHECKOUT_SAGA_ENGINE_UP = 'checkout_saga_engine_up';

// Bounded by the gRPC deadline, not a timer race, so a slow scrape leaves no call running behind it.
const SCRAPE_DEADLINE_MS = 2_000;
const CLOSED_WINDOW_MS = 60 * 60_000;
// The server keeps a poller listed for minutes after it stopped polling.
const POLLER_FRESH_MS = 60_000;
const WARN_EVERY_MS = 60_000;

const OPEN_STEPS = [
  CheckoutStep.RESERVING,
  CheckoutStep.AWAITING_AUTH,
  CheckoutStep.COMMITTING_STOCK,
  CheckoutStep.CAPTURING,
  CheckoutStep.COMPENSATING,
] as const;
type OpenStep = (typeof OPEN_STEPS)[number];

// The saga never closes like this on its own: each one is a bug or an operator.
const ABNORMAL_CLOSES = ['Failed', 'Terminated', 'TimedOut', 'Canceled'] as const;
type AbnormalClose = (typeof ABNORMAL_CLOSES)[number];

// temporal.api.enums.v1.TaskQueueType and TaskQueueKind.NORMAL; @temporalio/proto is not a dependency.
const TASK_QUEUE_TYPES = { workflow: 1, activity: 2 } as const;
type TaskType = keyof typeof TASK_QUEUE_TYPES;
const TASK_QUEUE_KIND_NORMAL = 1;

interface ScrapeSource {
  client: Client;
  namespace: string;
  taskQueue: string;
  overdueGraceSec: number;
  logger: PinoLogger;
  lastWarnAt: number;
}

interface SagaSnapshot {
  open: Record<OpenStep, number>;
  overdue: number;
  closedAbnormally: Record<AbnormalClose, number>;
  pollers: Record<TaskType, number>;
  backlogAgeSeconds: Record<TaskType, number>;
}

const binding = createCollectorBinding<ScrapeSource>();
// prom-client starts every collect() of a scrape before awaiting any; they share this one read.
let inFlight: Promise<SagaSnapshot | null> | null = null;

/** Resolves to null when unbound or when any call failed: half a snapshot would read as a real one. */
function readSnapshot(): Promise<SagaSnapshot | null> {
  const source = binding.current();
  if (!source) return Promise.resolve(null);
  return (inFlight ??= snapshotOf(source)
    .catch((error: unknown) => {
      const now = Date.now();
      if (now - source.lastWarnAt >= WARN_EVERY_MS) {
        source.lastWarnAt = now;
        source.logger.warn({ err: toError(error) }, 'checkout saga scrape failed, saga gauges withdrawn');
      }
      return null;
    })
    .finally(() => {
      inFlight = null;
    }));
}

async function snapshotOf({ client, namespace, taskQueue, overdueGraceSec }: ScrapeSource): Promise<SagaSnapshot> {
  const now = Date.now();
  const runs = checkoutSagaRunsOf(taskQueue);
  const running = `${runs} AND ExecutionStatus = 'Running'`;
  const count = async (query: string) => (await client.workflow.count(query)).count;
  const describe = (task: TaskType) =>
    client.workflowService.describeTaskQueue({
      namespace,
      taskQueue: { name: taskQueue, kind: TASK_QUEUE_KIND_NORMAL },
      taskQueueType: TASK_QUEUE_TYPES[task],
      reportStats: true,
    });

  return client.connection.withDeadline(now + SCRAPE_DEADLINE_MS, async () => {
    const [open, overdue, closed, workflowQueue, activityQueue] = await settleEvery([
      settleEvery(OPEN_STEPS.map((step) => count(`${running} AND ${checkoutStepKey.name} = '${step}'`))),
      count(`${running} AND ${checkoutDeadlineKey.name} < '${new Date(now - overdueGraceSec * 1000).toISOString()}'`),
      client.workflow.count(
        `${runs} AND CloseTime > '${new Date(now - CLOSED_WINDOW_MS).toISOString()}' GROUP BY ExecutionStatus`,
      ),
      describe('workflow'),
      describe('activity'),
    ]);

    const closedBy = new Map(closed.groups.map((group) => [String(group.groupValues[0]?.[0]), group.count]));
    const queues = { workflow: workflowQueue, activity: activityQueue };
    const perTaskType = (read: (queue: typeof workflowQueue) => number) =>
      ({ workflow: read(queues.workflow), activity: read(queues.activity) }) as Record<TaskType, number>;

    return {
      open: Object.fromEntries(OPEN_STEPS.map((step, index) => [step, open[index]])) as Record<OpenStep, number>,
      overdue,
      closedAbnormally: Object.fromEntries(
        ABNORMAL_CLOSES.map((status) => [status, closedBy.get(status) ?? 0]),
      ) as Record<AbnormalClose, number>,
      pollers: perTaskType(
        ({ pollers }) =>
          (pollers ?? []).filter(({ lastAccessTime }) => now - (optionalTsToMs(lastAccessTime) ?? 0) <= POLLER_FRESH_MS)
            .length,
      ),
      backlogAgeSeconds: perTaskType(({ stats }) => (optionalTsToMs(stats?.approximateBacklogAge) ?? 0) / 1000),
    };
  });
}

/**
 * Promise.all that waits out every call before failing. A call left retrying behind the first
 * failure can fire after shutdown closed the connection, and that throws from a timer.
 */
async function settleEvery<T extends readonly unknown[] | []>(
  calls: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  await Promise.allSettled(calls);
  return Promise.all(calls);
}

function labelled(gauge: Gauge<string>, label: string, values: Record<string, number> | undefined): void {
  gauge.reset();
  for (const [value, count] of Object.entries(values ?? {})) gauge.set({ [label]: value }, count);
}

@Injectable()
export class CheckoutSagaCollectorBinding implements OnModuleInit, OnModuleDestroy {
  private readonly source: ScrapeSource;

  constructor(@Inject(TEMPORAL_CLIENT) client: Client, config: ConfigService, logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
    const { temporal, overdueGraceSec } = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
    this.source = {
      client,
      namespace: temporal.namespace,
      taskQueue: temporal.taskQueue,
      overdueGraceSec,
      logger,
      lastWarnAt: -Infinity,
    };
  }

  onModuleInit(): void {
    binding.bind(this.source);
  }

  // The connection closes at application shutdown, after this; a scrape still on it finishes first.
  async onModuleDestroy(): Promise<void> {
    binding.unbind(this.source);
    await inFlight;
  }
}

// A withdrawn saga gauge, never a held one: the last value of a Temporal we cannot reach is a guess.
export const CHECKOUT_SAGA_COLLECTOR_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: CHECKOUT_SAGAS_OPEN,
    help: 'Checkout sagas running, by the step they are at.',
    labelNames: ['step'],
    async collect(this: Gauge<string>) {
      labelled(this, 'step', (await readSnapshot())?.open);
    },
  }),
  makeGaugeProvider({
    name: CHECKOUT_SAGA_OVERDUE,
    help: 'Checkout sagas still running past their payment deadline plus SAGA_OVERDUE_GRACE_SEC.',
    async collect(this: Gauge<string>) {
      const snapshot = await readSnapshot();
      if (snapshot) this.set(snapshot.overdue);
      else this.remove();
    },
  }),
  makeGaugeProvider({
    name: CHECKOUT_SAGA_CLOSED_ABNORMALLY,
    help: 'Checkout sagas closed in the last hour as Failed, Terminated, TimedOut or Canceled.',
    labelNames: ['status'],
    async collect(this: Gauge<string>) {
      labelled(this, 'status', (await readSnapshot())?.closedAbnormally);
    },
  }),
  makeGaugeProvider({
    name: CHECKOUT_SAGA_TASK_QUEUE_POLLERS,
    help: 'Workers that polled the checkout task queue in the last minute, by task type.',
    labelNames: ['task_type'],
    async collect(this: Gauge<string>) {
      labelled(this, 'task_type', (await readSnapshot())?.pollers);
    },
  }),
  makeGaugeProvider({
    name: CHECKOUT_SAGA_TASK_QUEUE_BACKLOG_AGE_SECONDS,
    help: 'Age in seconds of the oldest checkout task no worker has picked up, by task type (0 when none).',
    labelNames: ['task_type'],
    async collect(this: Gauge<string>) {
      labelled(this, 'task_type', (await readSnapshot())?.backlogAgeSeconds);
    },
  }),
  makeGaugeProvider({
    name: CHECKOUT_SAGA_ENGINE_UP,
    help: '1 when the api read every checkout saga gauge from Temporal within 2s on this scrape, else 0.',
    async collect(this: Gauge<string>) {
      if (!binding.current()) {
        this.remove();
        return;
      }
      this.set((await readSnapshot()) ? 1 : 0);
    },
  }),
  CheckoutSagaCollectorBinding,
];
