import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { sampleId } from '@shared/testing/id-generator.double';
import type { OutboundEvent } from '../transport/domain-event-publisher.port';
import { KafkaDomainEventPublisher, type KafkaPublisherSettings } from './kafka-domain-event.publisher';
import { hasValidSignature, signValue } from './kafka-message-signature';

const SETTINGS: KafkaPublisherSettings = {
  prefix: 'jcool',
  signingKey: 's'.repeat(32),
  deliveryTimeoutMs: 5_000,
  unreadyForMs: 10_000,
};
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let nextId = 1;
function event(eventType = 'order.placed', traceparent: string | null = TRACEPARENT): OutboundEvent {
  const rowId = sampleId(nextId++);
  const aggregateId = sampleId(nextId++);
  return {
    rowId,
    eventType,
    aggregateId,
    envelope: {
      outboxId: rowId,
      aggregateType: 'Order',
      aggregateId,
      eventType,
      payload: { note: 'đơn hàng' },
      occurredAt: '2026-10-17T00:00:00.000Z',
      traceparent,
    },
  };
}

type Send = (record: KafkaJS.ProducerRecord) => Promise<KafkaJS.RecordMetadata[]>;

function fakeProducer(send: Send = () => Promise.resolve([])) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(send),
  };
}

function build(producers: Array<ReturnType<typeof fakeProducer>> = [fakeProducer()]) {
  const logError = vi.fn();
  const queue = [...producers];
  const publisher = new KafkaDomainEventPublisher(
    () => (queue.shift() ?? producers.at(-1)!) as unknown as KafkaJS.Producer,
    SETTINGS,
    fakePinoLogger({ error: logError }),
  );
  return { publisher, producer: producers[0], logError };
}

async function connected(producers?: Array<ReturnType<typeof fakeProducer>>) {
  const t = build(producers);
  t.publisher.onModuleInit();
  await vi.advanceTimersByTimeAsync(0);
  return t;
}

const sentRecords = (producer: ReturnType<typeof fakeProducer>) => producer.send.mock.calls.map(([record]) => record);

describe('KafkaDomainEventPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not ready before the producer has connected', async () => {
    const pending = fakeProducer();
    pending.connect.mockReturnValue(new Promise(() => undefined));
    const t = build([pending]);

    expect(t.publisher.ready()).toBe(false);
    t.publisher.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(t.publisher.ready()).toBe(false);
  });

  it('connects in the background and keeps retrying a broker that is not there yet', async () => {
    const refused = fakeProducer();
    refused.connect.mockRejectedValue(new Error('Local: Broker transport failure'));
    const second = fakeProducer();
    const t = build([refused, second]);

    t.publisher.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.publisher.ready()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(t.publisher.ready()).toBe(true);
  });

  it('sends each event to its topic, keyed by aggregate, with the four headers', async () => {
    const t = await connected();
    const order = event('order.placed');
    const payment = event('payment.succeeded');

    await t.publisher.publish([order, payment]);

    const [first, second] = sentRecords(t.producer);
    expect(first.topic).toBe('jcool.order.events');
    expect(second.topic).toBe('jcool.payment.events');
    expect(first.messages).toHaveLength(1);
    const [message] = first.messages;
    expect(message.key).toBe(order.aggregateId);
    expect(message.headers).toEqual({
      message_id: order.rowId,
      event_type: 'order.placed',
      traceparent: TRACEPARENT,
      signature: expect.any(String) as unknown,
    });
  });

  it('signs exactly the bytes it sends, and the value is the envelope unchanged', async () => {
    const t = await connected();
    const sent = event();

    await t.publisher.publish([sent]);

    const [{ messages }] = sentRecords(t.producer);
    const value = messages[0].value as Buffer;
    expect(JSON.parse(value.toString('utf8'))).toEqual(sent.envelope);
    expect(messages[0].headers?.signature).toBe(signValue(SETTINGS.signingKey, value));
    expect(hasValidSignature(SETTINGS.signingKey, value, Buffer.from(String(messages[0].headers?.signature)))).toBe(
      true,
    );
  });

  it('leaves the traceparent header off an event written with no trace', async () => {
    const t = await connected();

    await t.publisher.publish([event('order.placed', null)]);

    expect(Object.keys(sentRecords(t.producer)[0].messages[0].headers ?? {})).not.toContain('traceparent');
  });

  it('settles every send on its own, so one refusal does not fail the batch', async () => {
    const refusal = new Error('Broker: Message size too large');
    const t = await connected([
      fakeProducer(async (record) => (record.topic === 'jcool.payment.events' ? Promise.reject(refusal) : [])),
    ]);
    const [order, payment] = [event('order.placed'), event('payment.failed')];

    await expect(t.publisher.publish([order, payment])).resolves.toEqual([
      { rowId: order.rowId, ok: true },
      { rowId: payment.rowId, ok: false, error: refusal },
    ]);
    expect(t.publisher.ready()).toBe(true);
  });

  it('turns unready for the reset window once every send in a batch fails, then tries again', async () => {
    const t = await connected([fakeProducer(async () => Promise.reject(new Error('Local: Message timed out')))]);

    const outcomes = await t.publisher.publish([event(), event()]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false]);
    expect(t.publisher.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTINGS.unreadyForMs - 1);
    expect(t.publisher.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.publisher.ready()).toBe(true);
  });

  it('refuses an event type with no topic without sending it, and stays ready', async () => {
    const t = await connected();
    const stray = event('refund.issued');

    const [outcome] = await t.publisher.publish([stray]);

    expect(outcome).toMatchObject({ rowId: stray.rowId, ok: false, error: expect.any(Error) as unknown });
    expect(t.producer.send).not.toHaveBeenCalled();
    expect(t.publisher.ready()).toBe(true);
    expect(t.logError).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: stray.rowId, eventType: 'refund.issued' }),
      expect.any(String),
    );
  });

  // The relay holds the batch's row locks for as long as this takes.
  it('returns once the delivery timeout runs out, failing only the sends still unanswered', async () => {
    const t = await connected([
      fakeProducer(async (record) => (record.topic === 'jcool.order.events' ? new Promise(() => undefined) : [])),
    ]);
    const [hung, acked] = [event('order.placed'), event('payment.succeeded')];

    let result: unknown;
    void t.publisher.publish([hung, acked]).then((outcomes) => (result = outcomes));
    await vi.advanceTimersByTimeAsync(SETTINGS.deliveryTimeoutMs - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual([
      {
        rowId: hung.rowId,
        ok: false,
        error: expect.objectContaining({ message: expect.stringContaining('5000ms') as unknown }) as unknown,
      },
      { rowId: acked.rowId, ok: true },
    ]);
  });

  it('refuses the batch without sending while it is not connected', async () => {
    const t = build();

    const [outcome] = await t.publisher.publish([event()]);

    expect(outcome.ok).toBe(false);
    expect(t.producer.send).not.toHaveBeenCalled();
  });

  it('flushes on shutdown, bounded so a gone broker cannot hold the exit', async () => {
    const t = await connected();
    t.producer.disconnect.mockReturnValue(new Promise(() => undefined));

    let done = false;
    void t.publisher.onApplicationShutdown().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(done).toBe(true);
    expect(t.producer.disconnect).toHaveBeenCalledTimes(1);
  });
});
