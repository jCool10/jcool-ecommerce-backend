import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { sampleId } from '@shared/testing/id-generator.double';
import type { ConsumerDelivery } from '../consume/consumer-delivery';
import type { DomainEventJob } from '../queue/domain-event.job';
import { KafkaConsumerGroupRunner, verifyInbound } from './kafka-consumer-group.runner';
import { signValue } from './kafka-message-signature';

const KEY = 'k'.repeat(32);
const OTHER_KEY = 'o'.repeat(32);
const ORDER_TOPIC = 'jcool.order.events';

function envelope(eventType = 'order.placed'): DomainEventJob {
  return {
    outboxId: sampleId(1),
    aggregateType: 'Order',
    aggregateId: sampleId(2),
    eventType,
    payload: { email: 'buyer@example.test' },
    occurredAt: '2026-10-17T00:00:00.000Z',
    traceparent: null,
  };
}

function signed(body: unknown, key = KEY): { value: Buffer; headers: KafkaJS.IHeaders } {
  const value = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { value, headers: { signature: Buffer.from(signValue(key, value)) } };
}

function message(offset: string, content = signed(envelope())): KafkaJS.KafkaMessage {
  return {
    key: null,
    value: content.value,
    headers: content.headers,
    offset,
    timestamp: '0',
    attributes: 0,
  } as unknown as KafkaJS.KafkaMessage;
}

function fakeConsumer() {
  const handlers: { eachMessage?: KafkaJS.EachMessageHandler } = {};
  return {
    handlers,
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn((config: KafkaJS.ConsumerRunConfig) => {
      handlers.eachMessage = config.eachMessage;
      return Promise.resolve();
    }),
    commitOffsets: vi
      .fn<(offsets: KafkaJS.TopicPartitionOffsetAndMetadata[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    assignment: vi.fn<() => KafkaJS.TopicPartition[]>(() => []),
  };
}

type FakeConsumer = ReturnType<typeof fakeConsumer>;

function build(
  deliver: ConsumerDelivery['deliver'] = vi.fn().mockResolvedValue('processed'),
  consumers = [fakeConsumer()],
) {
  const configs: KafkaJS.ConsumerConstructorConfig[] = [];
  const queue = [...consumers];
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const recordDeadLetter = vi.fn();
  const log = { warn: vi.fn(), error: vi.fn() };
  const runner = new KafkaConsumerGroupRunner(
    'domain-events',
    (config) => {
      configs.push(config);
      return (queue.shift() ?? consumers.at(-1)!) as unknown as KafkaJS.Consumer;
    },
    { prefix: 'jcool', signingKey: KEY },
    { deliver } as ConsumerDelivery,
    cls as unknown as ClsService,
    { recordDeadLetter } as unknown as MetricsPort,
    fakePinoLogger(log),
  );
  return { runner, consumer: consumers[0], configs, cls, recordDeadLetter, log, deliver: vi.mocked(deliver) };
}

async function started(t: ReturnType<typeof build>) {
  t.runner.start();
  await vi.advanceTimersByTimeAsync(0);
  return t;
}

const consume = (consumer: FakeConsumer, msg: KafkaJS.KafkaMessage, partition = 0, topic = ORDER_TOPIC) =>
  consumer.handlers.eachMessage!({
    topic,
    partition,
    message: msg,
    heartbeat: () => Promise.resolve(),
    pause: () => () => {},
  });

const committed = (consumer: FakeConsumer) => consumer.commitOffsets.mock.calls.map(([offsets]) => offsets);

describe('verifyInbound', () => {
  it('hands on a message signed with the key, on the topic its event type routes to', () => {
    expect(verifyInbound(KEY, 'order.events', signed(envelope()).value, signed(envelope()).headers)).toEqual({
      verified: true,
      envelope: envelope(),
    });
  });

  it('names why it refused a message', () => {
    const { value } = signed(envelope());
    const cases: Array<[string, ReturnType<typeof signed>, string]> = [
      ['missing_signature', { value, headers: {} }, 'order.events'],
      ['bad_signature', signed(envelope(), OTHER_KEY), 'order.events'],
      ['topic_mismatch', signed(envelope()), 'payment.events'],
      ['topic_mismatch', signed(envelope('refund.issued')), 'order.events'],
      ['topic_mismatch', signed({ outboxId: '1' }), 'order.events'],
    ];
    for (const [reason, content, topic] of cases) {
      expect(verifyInbound(KEY, topic as 'order.events', content.value, content.headers), reason).toEqual({
        verified: false,
        reason,
      });
    }
  });

  it('passes a signed value that is not JSON on as undefined', () => {
    const content = signed('{not json');

    expect(verifyInbound(KEY, 'order.events', content.value, content.headers)).toEqual({
      verified: true,
      envelope: undefined,
    });
  });
});

describe('KafkaConsumerGroupRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins its prefixed group on the KIP-848 protocol, committing by hand, one partition at a time', async () => {
    const t = await started(build());

    expect(t.configs[0]).toMatchObject({
      kafkaJS: { groupId: 'jcool.domain-events', autoCommit: false, fromBeginning: true },
      'group.protocol': 'consumer',
    });
    expect(t.consumer.subscribe).toHaveBeenCalledWith({ topics: ['jcool.order.events', 'jcool.payment.events'] });
    expect(t.consumer.run).toHaveBeenCalledWith(expect.objectContaining({ partitionsConsumedConcurrently: 1 }));
  });

  it('keeps retrying a broker that is not there yet without throwing', async () => {
    const refused = fakeConsumer();
    refused.connect.mockRejectedValue(new Error('Local: Broker transport failure'));
    const second = fakeConsumer();
    const t = await started(build(undefined, [refused, second]));

    expect(second.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(second.run).toHaveBeenCalledTimes(1);
    expect(t.log.error).toHaveBeenCalled();
  });

  it('commits the offset after the message as a string, past Number.MAX_SAFE_INTEGER too', async () => {
    const t = await started(build());

    await consume(t.consumer, message('9007199254740993'));

    expect(t.deliver).toHaveBeenCalledWith('domain-events', envelope());
    expect(committed(t.consumer)).toEqual([[{ topic: ORDER_TOPIC, partition: 0, offset: '9007199254740994' }]]);
  });

  it('commits a delivery that came back dead, since its outcome is already durable', async () => {
    const t = await started(build(vi.fn().mockResolvedValue('dead')));

    await consume(t.consumer, message('4'));

    expect(committed(t.consumer)).toEqual([[{ topic: ORDER_TOPIC, partition: 0, offset: '5' }]]);
  });

  it('gives each delivery its own correlation scope', async () => {
    const t = await started(build());

    await consume(t.consumer, message('0'));
    await consume(t.consumer, message('1'));

    expect(t.cls.run).toHaveBeenCalledTimes(2);
    expect(t.cls.set).toHaveBeenCalledWith(expect.anything(), 'domain-events:order.placed');
  });

  // Only a retry row Postgres would not take gets here, and the client redelivers every ~500ms.
  it('waits a doubling, capped delay before handing an unparkable delivery back, and commits nothing', async () => {
    const parkFailure = new Error('Connection terminated unexpectedly');
    const t = await started(build(vi.fn().mockRejectedValue(parkFailure)));
    const waits: number[] = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const startedAt = Date.now();
      let settled = false;
      const delivery = consume(t.consumer, message('3')).catch((error: unknown) => {
        settled = true;
        return error;
      });
      while (!settled) await vi.advanceTimersByTimeAsync(100);
      await expect(delivery).resolves.toBe(parkFailure);
      waits.push(Math.round((Date.now() - startedAt) / 100) * 100);
    }

    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(t.consumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('keeps the delay per partition and starts a partition over after a success', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('pg down'));
    const t = await started(build(deliver));
    const timed = async (partition: number): Promise<number> => {
      const startedAt = Date.now();
      let settled = false;
      const delivery = consume(t.consumer, message('7'), partition).catch(() => (settled = true));
      while (!settled) await vi.advanceTimersByTimeAsync(100);
      await delivery;
      return Date.now() - startedAt;
    };

    await timed(0);
    await timed(0);
    expect(await timed(1)).toBe(500);

    deliver.mockResolvedValueOnce('processed');
    await consume(t.consumer, message('7'), 0);
    expect(await timed(0)).toBe(500);
  });

  it('cancels a wait the moment shutdown starts, commits nothing, and disconnects', async () => {
    const t = await started(build(vi.fn().mockRejectedValue(new Error('pg down'))));
    let settled = false;
    const delivery = consume(t.consumer, message('3')).catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);

    await t.runner.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await delivery;
    expect(t.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(t.consumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('gives up on a disconnect that has not returned after 10s', async () => {
    const t = await started(build());
    t.consumer.disconnect.mockReturnValue(new Promise(() => undefined));

    let done = false;
    void t.runner.stop().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(done).toBe(true);
  });

  it('drops an unsigned, wrongly signed or misrouted message without delivering it, and commits past it', async () => {
    const unverified = [
      { value: signed(envelope()).value, headers: {} },
      signed(envelope(), OTHER_KEY),
      signed(envelope('payment.succeeded')),
    ];
    for (const [index, content] of unverified.entries()) {
      const t = await started(build());

      await consume(t.consumer, message(String(index), content));

      expect(t.deliver).not.toHaveBeenCalled();
      expect(t.recordDeadLetter).toHaveBeenCalledExactlyOnceWith('unverified', 'permanent');
      expect(committed(t.consumer)).toEqual([[{ topic: ORDER_TOPIC, partition: 0, offset: String(index + 1) }]]);
      const [fields] = t.log.warn.mock.calls[0] as [Record<string, unknown>];
      expect(Object.keys(fields).sort()).toEqual(['offset', 'partition', 'reason', 'topic']);
      expect(JSON.stringify(t.log.warn.mock.calls)).not.toContain('buyer@example.test');
    }
  });

  it('hands an undecodable but signed value to the delivery as undefined', async () => {
    const t = await started(build());

    await consume(t.consumer, message('0', signed('{not json')));

    expect(t.deliver).toHaveBeenCalledWith('domain-events', undefined);
    expect(t.consumer.commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('reports a join once partitions have been assigned to it', async () => {
    const t = await started(build());
    const rebalance = t.configs[0].rebalance_cb as (
      error: { code: number },
      assignment: KafkaJS.TopicPartition[],
    ) => void;

    expect(t.runner.hasJoined()).toBe(false);
    rebalance({ code: KafkaJS.ErrorCodes.ERR__ASSIGN_PARTITIONS }, [{ topic: ORDER_TOPIC, partition: 0 }]);

    expect(t.runner.hasJoined()).toBe(true);
  });

  it('reports the partitions it holds right now, and none while it is not connected', async () => {
    const t = build();
    expect(t.runner.assignment()).toEqual([]);

    await started(t);
    t.consumer.assignment.mockReturnValue([{ topic: ORDER_TOPIC, partition: 2 }]);
    expect(t.runner.assignment()).toEqual([{ topic: ORDER_TOPIC, partition: 2 }]);

    t.consumer.assignment.mockImplementation(() => {
      throw new Error('Assignment can only be called while connected.');
    });
    expect(t.runner.assignment()).toEqual([]);
  });
});
