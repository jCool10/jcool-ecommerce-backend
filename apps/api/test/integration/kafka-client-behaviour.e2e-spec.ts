import { KafkaJS } from '@confluentinc/kafka-javascript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOPIC_SPEC } from '../../src/shared/messaging/kafka/kafka-topology';
import { freePort, startKafka } from '../setup/kafka-container';
import { describeTopicConfigs } from '../setup/kafka-topic-configs';
import { sleep } from '../setup/sleep';

// Each case pins what @confluentinc/kafka-javascript 1.11.0 does against a real broker, so an upgrade
// turns red exactly the case whose behaviour changed. The transport adapters are written against these.

type Received = { offset: string; at: number };

const silent: KafkaJS.Logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  namespace: () => silent,
  setLogLevel: () => undefined,
};

const kafkaFor = (brokers: string[]) =>
  new KafkaJS.Kafka({ kafkaJS: { brokers, clientId: 'kafka-client-behaviour', logger: silent } });

describe('Kafka client behaviour (real broker)', () => {
  const run = `e2e.kafka-client-behaviour.${Date.now()}`;
  const kafka = kafkaFor(process.env.KAFKA_BROKERS!.split(','));
  const created: string[] = [];
  const connected: Array<{ disconnect(): Promise<void> }> = [];
  let admin: KafkaJS.Admin;

  beforeAll(async () => {
    admin = kafka.admin();
    await admin.connect();
  });

  afterEach(async () => {
    await Promise.allSettled(connected.splice(0).map((client) => client.disconnect()));
  });

  afterAll(async () => {
    if (created.length > 0) await admin.deleteTopics({ topics: created });
    await admin.disconnect();
  });

  async function topic(name: string, numPartitions = 1, messages: KafkaJS.Message[] = []): Promise<string> {
    const full = `${run}.${name}`;
    await admin.createTopics({ topics: [{ topic: full, numPartitions }] });
    created.push(full);
    if (messages.length > 0) {
      const producer = track(kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } }));
      await producer.connect();
      await producer.send({ topic: full, messages });
      await producer.disconnect();
    }
    return full;
  }

  function track<T extends { disconnect(): Promise<void> }>(client: T): T {
    connected.push(client);
    return client;
  }

  // The settings the consumer runner uses: manual commits and the KIP-848 group protocol.
  function consumer(group: string): KafkaJS.Consumer {
    return track(
      kafka.consumer({
        kafkaJS: { groupId: `${run}.${group}`, autoCommit: false, fromBeginning: true },
        'group.protocol': 'consumer',
      }),
    );
  }

  async function subscribe(c: KafkaJS.Consumer, t: string, eachMessage: KafkaJS.EachMessageHandler): Promise<void> {
    await c.connect();
    await c.subscribe({ topic: t });
    await c.run({ eachMessage });
  }

  const threeOnOnePartition = () => ['m0', 'm1', 'm2'].map((value) => ({ key: 'one-key', value }));
  const committed = async (group: string, t: string) =>
    (await admin.fetchOffsets({ groupId: `${run}.${group}`, topics: [t] })).flatMap((entry) =>
      entry.partitions.map(({ partition, offset }) => ({ partition, offset })),
    );

  it('reads back a committed offset + 1 as the next offset to consume', async () => {
    const t = await topic('commit', 1, threeOnOnePartition());
    const c = consumer('commit');
    await subscribe(c, t, async ({ partition, message }) => {
      if (message.offset === '1') await c.commitOffsets([{ topic: t, partition, offset: '2' }]);
    });

    await vi.waitFor(async () => expect(await committed('commit', t)).toEqual([{ partition: 0, offset: '2' }]), {
      timeout: 20_000,
      interval: 200,
    });
  });

  it('waits for a running handler before disconnect returns', async () => {
    const t = await topic('drain', 1, [{ value: 'slow' }]);
    const c = consumer('drain');
    let started = 0;
    let finished = 0;
    await subscribe(c, t, async () => {
      started = Date.now();
      await sleep(1_500);
      finished = Date.now();
    });
    await vi.waitFor(() => expect(started).toBeGreaterThan(0), { timeout: 20_000, interval: 20 });

    const disconnectAt = Date.now();
    await c.disconnect();

    expect(Date.now() - disconnectAt).toBeGreaterThanOrEqual(1_400);
    expect(finished).toBeGreaterThan(0);
  });

  it('hands headers back as Buffers even when they were sent as strings', async () => {
    const t = await topic('headers', 1, [{ value: 'v', headers: { message_id: '42', event_type: 'order.paid' } }]);
    const c = consumer('headers');
    let headers: KafkaJS.IHeaders | undefined;
    await subscribe(c, t, ({ message }) => {
      headers = message.headers;
      return Promise.resolve();
    });

    await vi.waitFor(() => expect(headers).toBeDefined(), { timeout: 20_000, interval: 50 });
    expect(Buffer.isBuffer(headers!.message_id)).toBe(true);
    expect(String(headers!.message_id)).toBe('42');
    expect(String(headers!.event_type)).toBe('order.paid');
  });

  // The consumer runner relies on this: a throw keeps the partition on the failed message.
  it('redelivers a message whose handler threw, at the same offset, before anything behind it', async () => {
    const t = await topic('throw', 1, threeOnOnePartition());
    const c = consumer('throw');
    const seen: string[] = [];
    let failures = 0;
    await subscribe(c, t, ({ message }) => {
      seen.push(message.offset);
      if (message.offset === '1' && failures < 2) {
        failures++;
        return Promise.reject(new Error('handler failed'));
      }
      return Promise.resolve();
    });

    await vi.waitFor(() => expect(seen).toContain('2'), { timeout: 20_000, interval: 50 });
    expect(seen).toEqual(['0', '1', '1', '1', '2']);
  });

  // `kafkaJS.timeout` does not bound a send at all (300s, librdkafka's default); 'message.timeout.ms' does.
  it('rejects a send within message.timeout.ms once the broker has gone away', async () => {
    const own = await startKafka();
    try {
      const ownKafka = kafkaFor([own.brokers]);
      const ownAdmin = ownKafka.admin();
      await ownAdmin.connect();
      await ownAdmin.createTopics({ topics: [{ topic: 'gone' }] });
      await ownAdmin.disconnect();

      const producer = track(
        ownKafka.producer({ kafkaJS: { idempotent: true, acks: -1 }, 'message.timeout.ms': 2_000 }),
      );
      await producer.connect();
      // The producer knows the topic and its leader, so the second send can only fail on the lost broker.
      await producer.send({ topic: 'gone', messages: [{ value: 'before' }] });
      await own.container.stop();

      const sentAt = Date.now();
      const error = (await producer
        .send({ topic: 'gone', messages: [{ value: 'after' }] })
        .catch((e: unknown) => e)) as KafkaJS.KafkaJSError | undefined;

      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(2_000);
      expect(Date.now() - sentAt).toBeLessThan(4_000);
      expect(error).toBeInstanceOf(KafkaJS.KafkaJSError);
      expect(error?.code).toBe(KafkaJS.ErrorCodes.ERR__MSG_TIMED_OUT);
    } finally {
      await own.container.stop().catch(() => undefined);
    }
  });

  // A group with no commit has no entry at all, not '-1': lag code reads a missing partition as `low`.
  it('returns no partitions for a group that has never committed, joined or not', async () => {
    const t = await topic('uncommitted', 3);
    expect(await committed('never-joined', t)).toEqual([]);

    const c = consumer('joined');
    await subscribe(c, t, () => Promise.resolve());
    await vi.waitFor(() => expect(c.assignment().length).toBeGreaterThan(0), { timeout: 20_000, interval: 100 });

    expect(await committed('joined', t)).toEqual([]);
  });

  it('splits partitions between two members and hands them all to the survivor within 10s', async () => {
    const t = await topic('rebalance', 3);
    const first = consumer('rebalance');
    const second = consumer('rebalance');
    await subscribe(first, t, () => Promise.resolve());
    await subscribe(second, t, () => Promise.resolve());

    await vi.waitFor(
      () => {
        expect(first.assignment().length).toBeGreaterThan(0);
        expect(second.assignment().length).toBeGreaterThan(0);
        expect(first.assignment().length + second.assignment().length).toBe(3);
      },
      { timeout: 20_000, interval: 100 },
    );

    await first.disconnect();
    await vi.waitFor(() => expect(second.assignment()).toHaveLength(3), { timeout: 10_000, interval: 100 });
  });

  it('accepts an idempotent, acks=all producer and reports one entry per partition, not per message', async () => {
    const t = await topic('report', 3);
    const producer = track(kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } }));
    await producer.connect();

    const report = await producer.send({
      topic: t,
      messages: [0, 1, 2, 0, 1, 2].map((partition, i) => ({ partition, value: `m${i}` })),
    });

    expect(report.map(({ partition }) => partition).sort()).toEqual([0, 1, 2]);
    for (const entry of report) expect(entry).toMatchObject({ errorCode: 0, baseOffset: '0' });
  });

  // What makes "do not commit until the result is durable" safe across a crash or a deploy.
  it('commits nothing for a message whose handler threw, so the next member starts on it', async () => {
    const t = await topic('crash', 1, threeOnOnePartition());
    const c = consumer('crash');
    let threw = false;
    await subscribe(c, t, async ({ partition, message }) => {
      if (message.offset === '1') {
        threw = true;
        throw new Error('handler failed');
      }
      await c.commitOffsets([{ topic: t, partition, offset: String(Number(message.offset) + 1) }]);
    });
    await vi.waitFor(() => expect(threw).toBe(true), { timeout: 20_000, interval: 20 });

    await c.disconnect();
    expect(await committed('crash', t)).toEqual([{ partition: 0, offset: '1' }]);

    const next = consumer('crash');
    const seen: string[] = [];
    await subscribe(next, t, ({ message }) => {
      seen.push(message.offset);
      return Promise.resolve();
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 20_000, interval: 50 });
    expect(seen[0]).toBe('1');
  });

  // No backoff of its own: the runner has to add one before rethrowing.
  it('redelivers a message that keeps failing at a steady ~500ms, without backing off', async () => {
    const t = await topic('cadence', 1, [{ value: 'poison' }]);
    const c = consumer('cadence');
    const deliveries: Received[] = [];
    await subscribe(c, t, ({ message }) => {
      deliveries.push({ offset: message.offset, at: Date.now() });
      return deliveries.length <= 6 ? Promise.reject(new Error('handler failed')) : Promise.resolve();
    });

    await vi.waitFor(() => expect(deliveries.length).toBeGreaterThanOrEqual(7), { timeout: 30_000, interval: 50 });
    const gaps = deliveries.slice(1, 7).map((d, i) => d.at - deliveries[i].at);

    expect(deliveries.every((d) => d.offset === '0')).toBe(true);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(400);
      expect(gap).toBeLessThan(1_500);
    }
  });

  // The provisioning CLI's own deadline is the bound it relies on; this shows it is not the only one.
  it('fails an admin call against a closed port on its own after about five seconds', async () => {
    const unreachable = track(kafkaFor([`127.0.0.1:${await freePort()}`]).admin());
    const startedAt = Date.now();

    const error = await unreachable
      .connect()
      .then(() => unreachable.listTopics())
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(KafkaJS.KafkaJSConnectionError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  });

  // Provisioning can only check partitions; config drift is a RUNBOOK check with the broker's own tool.
  it('applies config entries on create, but has no describeConfigs to read them back', async () => {
    const t = `${run}.configs`;
    const configEntries = Object.entries(TOPIC_SPEC.configs).map(([name, value]) => ({ name, value }));

    const createdNew = await admin.createTopics({ topics: [{ topic: t, numPartitions: 3, configEntries }] });
    created.push(t);

    expect(createdNew).toBe(true);
    // createTopics returns before the broker's metadata shows the topic.
    await vi.waitFor(async () => expect(await describeTopicConfigs(t)).toMatchObject(TOPIC_SPEC.configs), {
      timeout: 10_000,
      interval: 200,
    });
    expect(await admin.createTopics({ topics: [{ topic: t, numPartitions: 3 }] })).toBe(false);
    expect('describeConfigs' in admin).toBe(false);
  });
});
