import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Gauge } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { KafkaLagReader, type LagSource } from './kafka-lag.collector';

const ORDER = 'jcool.order.events';
const PAYMENT = 'jcool.payment.events';

function source(joined = true): LagSource {
  return {
    name: 'domain-events',
    groupId: 'jcool.domain-events',
    subscribedTopics: [ORDER, PAYMENT],
    hasJoined: () => joined,
  };
}

type Committed = Array<{ topic: string; partitions: Array<{ partition: number; offset: string }> }>;
type Watermarks = Record<string, Array<{ partition: number; low: string; high: string }>>;

function fakeAdmin(committed: Committed = [], watermarks: Watermarks = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchOffsets: vi.fn().mockResolvedValue(committed),
    fetchTopicOffsets: vi.fn((topic: string) =>
      Promise.resolve((watermarks[topic] ?? []).map((w) => ({ ...w, offset: w.high }))),
    ),
  };
}

function build(admin = fakeAdmin(), sources = [source()]) {
  const newAdmin = vi.fn(() => admin as unknown as KafkaJS.Admin);
  const warn = vi.fn();
  const reader = new KafkaLagReader(() => sources, newAdmin, fakePinoLogger({ warn }));
  const gauge = new Gauge({
    name: 'test_consumer_lag',
    help: 'test',
    labelNames: ['group', 'topic', 'partition'],
    registers: [],
  });
  return { reader, admin, newAdmin, warn, gauge };
}

async function values(gauge: Gauge<string>) {
  return (await gauge.get()).values.map(({ labels, value }) => ({ ...labels, value }));
}

describe('KafkaLagReader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports each partition as its high watermark minus the committed offset', async () => {
    const t = build(
      fakeAdmin(
        [
          {
            topic: ORDER,
            partitions: [
              { partition: 0, offset: '7' },
              { partition: 1, offset: '9007199254740993' },
            ],
          },
        ],
        {
          [ORDER]: [
            { partition: 0, low: '0', high: '10' },
            { partition: 1, low: '0', high: '9007199254740995' },
          ],
        },
      ),
    );

    await t.reader.observe(t.gauge);

    expect(await values(t.gauge)).toEqual([
      { group: 'domain-events', topic: ORDER, partition: '0', value: 3 },
      { group: 'domain-events', topic: ORDER, partition: '1', value: 2 },
    ]);
    expect(t.admin.fetchOffsets).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'jcool.domain-events', topics: [ORDER, PAYMENT] }),
    );
  });

  it('counts a partition the group never committed on from its low watermark', async () => {
    const t = build(fakeAdmin([], { [PAYMENT]: [{ partition: 2, low: '4', high: '6' }] }));

    await t.reader.observe(t.gauge);

    expect(await values(t.gauge)).toEqual([{ group: 'domain-events', topic: PAYMENT, partition: '2', value: 2 }]);
  });

  // The first offset fetch on a fresh broker can wedge the admin for good; once a member has been
  // assigned partitions the group coordinator has answered, and it no longer does.
  it('asks the broker nothing until a group in this process has been assigned partitions', async () => {
    const t = build(fakeAdmin(), [source(false)]);

    await t.reader.observe(t.gauge);

    expect(t.newAdmin).not.toHaveBeenCalled();
    expect(await values(t.gauge)).toEqual([]);
  });

  it('keeps the last values when a read fails, and logs it once', async () => {
    const t = build(fakeAdmin([], { [ORDER]: [{ partition: 0, low: '0', high: '5' }] }));
    await t.reader.observe(t.gauge);
    t.admin.fetchOffsets.mockRejectedValue(new Error('Local: Timed out'));

    await t.reader.observe(t.gauge);

    expect(await values(t.gauge)).toEqual([{ group: 'domain-events', topic: ORDER, partition: '0', value: 5 }]);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it('returns after 2s on a read that has not come back, and lets the next scrape wait on that same read', async () => {
    const t = build();
    t.admin.fetchOffsets.mockReturnValue(new Promise(() => undefined));

    for (let scrape = 0; scrape < 2; scrape += 1) {
      let done = false;
      void t.reader.observe(t.gauge).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    }

    expect(t.admin.fetchOffsets).toHaveBeenCalledTimes(1);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it('retries the connect on the next scrape with a fresh admin', async () => {
    const refused = fakeAdmin();
    refused.connect.mockRejectedValue(new Error('Local: Broker transport failure'));
    const t = build(refused);
    await t.reader.observe(t.gauge);

    t.newAdmin.mockReturnValue(fakeAdmin() as unknown as KafkaJS.Admin);
    await t.reader.observe(t.gauge);

    expect(t.newAdmin).toHaveBeenCalledTimes(2);
  });

  it('disconnects an admin whose last read came back', async () => {
    const t = build();
    await t.reader.observe(t.gauge);

    await t.reader.onApplicationShutdown();

    expect(t.admin.disconnect).toHaveBeenCalledTimes(1);
  });

  // Disconnecting a wedged admin blocks the event loop until SIGKILL.
  it('leaves an admin alone at shutdown while a read is stuck, or after one failed', async () => {
    const stuck = build();
    stuck.admin.fetchOffsets.mockReturnValue(new Promise(() => undefined));
    void stuck.reader.observe(stuck.gauge);
    await vi.advanceTimersByTimeAsync(2_000);
    const failed = build();
    failed.admin.fetchOffsets.mockRejectedValue(new Error('Local: Timed out'));
    await failed.reader.observe(failed.gauge);

    await stuck.reader.onApplicationShutdown();
    await failed.reader.onApplicationShutdown();

    expect(stuck.admin.disconnect).not.toHaveBeenCalled();
    expect(failed.admin.disconnect).not.toHaveBeenCalled();
  });

  it('reads nothing once shut down', async () => {
    const t = build();
    await t.reader.onApplicationShutdown();

    await t.reader.observe(t.gauge);

    expect(t.newAdmin).not.toHaveBeenCalled();
  });
});
