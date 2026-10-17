import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { sampleId } from '@shared/testing/id-generator.double';
import type { OutboundEvent } from '../transport/domain-event-publisher.port';
import { BullmqDomainEventPublisher } from './bullmq-domain-event.publisher';
import { CATALOG_EVENT_PRIORITY } from './queue.constants';

let nextId = 1;
function event(eventType = 'order.placed'): OutboundEvent {
  const rowId = sampleId(nextId++);
  return {
    rowId,
    eventType,
    aggregateId: sampleId(0),
    envelope: {
      outboxId: rowId,
      aggregateType: 'Order',
      aggregateId: sampleId(0),
      eventType,
      payload: {},
      occurredAt: '2026-10-17T00:00:00.000Z',
      traceparent: null,
    },
  };
}

function build(status = 'ready') {
  const add = vi.fn<(name: string, data: unknown, opts?: JobsOptions) => Promise<void>>().mockResolvedValue(undefined);
  const publisher = new BullmqDomainEventPublisher({ add } as unknown as Queue, { status } as unknown as Redis);
  return { publisher, add };
}

describe('BullmqDomainEventPublisher', () => {
  it('is ready only while its Redis connection is', () => {
    expect(build('ready').publisher.ready()).toBe(true);
    expect(build('reconnecting').publisher.ready()).toBe(false);
  });

  // A job id would let BullMQ swallow a republish while it still remembers the row's earlier job.
  it('adds every event as a fresh job named after its type, and leaves dedup to the inbox', async () => {
    const t = build();
    const events = [event(), event('payment.succeeded')];

    await expect(t.publisher.publish(events)).resolves.toEqual(events.map(({ rowId }) => ({ rowId, ok: true })));

    expect(t.add.mock.calls.map(([name, data]) => [name, data])).toEqual(events.map((e) => [e.eventType, e.envelope]));
    expect(t.add.mock.calls.map(([, , opts]) => opts?.jobId)).toEqual([undefined, undefined]);
  });

  it('queues only catalog events behind order and payment work', async () => {
    const t = build();

    await t.publisher.publish([event('catalog.product.changed'), event('order.paid')]);

    expect(t.add.mock.calls.map(([, , opts]) => opts)).toEqual([{ priority: CATALOG_EVENT_PRIORITY }, undefined]);
  });

  it('reports a refused event without failing its neighbours', async () => {
    const t = build();
    const refusal = new Error('queue rejected the payload');
    t.add.mockRejectedValueOnce(refusal);
    const [refused, accepted] = [event(), event()];

    await expect(t.publisher.publish([refused, accepted])).resolves.toEqual([
      { rowId: refused.rowId, ok: false, error: refusal },
      { rowId: accepted.rowId, ok: true },
    ]);
  });

  // Each refusal can cost a full command timeout while the batch's row locks stay held.
  it('gives up on the batch after three refusals', async () => {
    const t = build();
    t.add.mockRejectedValue(new Error('Command timed out'));
    const events = Array.from({ length: 20 }, () => event());

    const outcomes = await t.publisher.publish(events);

    expect(t.add).toHaveBeenCalledTimes(3);
    expect(outcomes.map(({ rowId, ok }) => ({ rowId, ok }))).toEqual(events.map(({ rowId }) => ({ rowId, ok: false })));
    expect(outcomes.every((outcome) => outcome.error?.message === 'Command timed out')).toBe(true);
    expect(outcomes.map((outcome) => outcome.skipped === true)).toEqual(events.map((_, i) => i >= 3));
  });
});
