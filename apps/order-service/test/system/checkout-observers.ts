import { Client, Connection } from '@temporalio/client';
import { Queue } from 'bullmq';
import { checkoutWorkflowId } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';

export interface SagaRun {
  runId: string;
  status: string;
}

export interface ActivityRun {
  activity: string;
  attempt: number;
  lastTimeout: string | null;
}

// temporal.api.enums.v1.TimeoutType, by value.
const TIMEOUT_TYPES = ['UNSPECIFIED', 'START_TO_CLOSE', 'SCHEDULE_TO_START', 'SCHEDULE_TO_CLOSE', 'HEARTBEAT'];

/** Visibility and history of the checkout saga, from the harness's side of the mapped port. */
export class SagaObserver {
  private constructor(
    private readonly connection: Connection,
    private readonly client: Client,
  ) {}

  static async connect(address: string): Promise<SagaObserver> {
    const connection = await Connection.connect({ address });
    return new SagaObserver(connection, new Client({ connection, namespace: 'jcool' }));
  }

  async runs(orderId: string): Promise<SagaRun[]> {
    const runs: SagaRun[] = [];
    for await (const run of this.client.workflow.list({ query: `WorkflowId = '${checkoutWorkflowId(orderId)}'` })) {
      runs.push({ runId: run.runId, status: run.status.name });
    }
    return runs;
  }

  /** From the workflow itself, so a run that visibility has not listed yet still counts. */
  async latestRunId(orderId: string): Promise<string> {
    return (await this.client.workflow.getHandle(checkoutWorkflowId(orderId)).describe()).runId;
  }

  /**
   * Each activity's final attempt, as history records it: retries leave no events of their own, only
   * the attempt number and the previous attempt's failure on the started event.
   */
  async activityRuns(orderId: string): Promise<ActivityRun[]> {
    const { events } = await this.client.workflow.getHandle(checkoutWorkflowId(orderId)).fetchHistory();
    const scheduled = new Map<string, string>();
    const runs: ActivityRun[] = [];
    for (const event of events ?? []) {
      const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
      if (name) scheduled.set(String(event.eventId), name);
      const started = event.activityTaskStartedEventAttributes;
      if (!started) continue;
      const timeout = started.lastFailure?.timeoutFailureInfo;
      runs.push({
        activity: scheduled.get(String(started.scheduledEventId)) ?? '?',
        attempt: started.attempt ?? 1,
        lastTimeout: timeout ? (TIMEOUT_TYPES[timeout.timeoutType ?? 0] ?? 'UNKNOWN') : null,
      });
    }
    return runs;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseMetrics(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const [, key, value] of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[key] = value;
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return samples;
}

export function metricSum(
  samples: MetricSample[],
  name: string,
  where: (labels: Record<string, string>) => boolean = () => true,
): number {
  return samples.filter((s) => s.name === name && where(s.labels)).reduce((sum, s) => sum + s.value, 0);
}

export interface Mail {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

export async function mailsTo(mailpitUrl: string, email: string): Promise<Mail[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  if (!res.ok) throw new Error(`mailpit search: ${res.status}`);
  return ((await res.json()) as { messages: Mail[] }).messages;
}

export interface QueuedJob {
  id: string | undefined;
  name: string;
  data: { outboxId: string; aggregateId: string; eventType: string; payload: Record<string, unknown> };
  attempts: number | undefined;
  backoff: unknown;
  attemptsMade: number;
  failedReason: string | undefined;
  finishedOn: number | undefined;
}

/** Every job of `name` still in Redis, whatever its state, read the way the services' BullMQ sees them. */
export async function queueJobs(
  redis: { host: string; port: number },
  queueName: string,
  name: string,
): Promise<QueuedJob[]> {
  const queue = new Queue(queueName, { connection: { ...redis, maxRetriesPerRequest: null }, prefix: 'bull' });
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized'], 0, -1);
    return jobs
      .filter((job) => job.name === name)
      .map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data as QueuedJob['data'],
        attempts: job.opts.attempts,
        backoff: job.opts.backoff,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        finishedOn: job.finishedOn,
      }));
  } finally {
    await queue.close();
  }
}
