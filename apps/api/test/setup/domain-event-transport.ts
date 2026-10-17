import { randomUUID } from 'node:crypto';
import { KafkaConsumer, type Message } from '@confluentinc/kafka-javascript';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import pino from 'pino';
import { beforeEach, expect } from 'vitest';
import { toError } from '@jcool/kernel';
import { ConsumerDelivery, type DeliveryOutcome } from '../../src/shared/messaging/consume/consumer-delivery';
import { createKafka } from '../../src/shared/messaging/kafka/kafka-client.factory';
import { verifyInbound, type UnverifiedReason } from '../../src/shared/messaging/kafka/kafka-consumer-group.runner';
import {
  CONSUMER_GROUPS,
  TOPICS,
  TOPIC_SPEC,
  consumerFor,
  groupIdFor,
  qualifiedTopic,
  type ConsumerName,
  type KafkaTopic,
} from '../../src/shared/messaging/kafka/kafka-topology';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_CONSUMER, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';

/**
 * Reads what the relay published, through whichever transport the app is on, the way the consumers
 * would see it. Each read starts where the previous one stopped, so a spec delivers every message once:
 * Kafka by position (a republished row is a new message, and the inbox answers `duplicate`), BullMQ by
 * job id within the test.
 */

export interface PublishedEvent {
  consumer: string;
  /** Undefined for a value that is not JSON. */
  envelope: DomainEventJob | undefined;
  /** Set on a Kafka message the consumer would drop without reading it. */
  unverified?: UnverifiedReason;
  /** Kafka only. */
  record?: KafkaRecord;
}

export interface KafkaRecord {
  topic: string;
  partition: number;
  offset: number;
  key: string | undefined;
  headers: Record<string, string>;
}

export interface DeliveredEvent {
  consumer: string;
  eventType: string | undefined;
  outboxId: string | undefined;
  result: DeliveryOutcome | 'unverified';
}

const QUEUED_STATES = ['waiting', 'delayed', 'prioritized'] as const;
const READ_TIMEOUT_MS = 15_000;
const BROKER_TIMEOUT_MS = 5_000;

// `${topic}:${partition}` to the next offset to read, per broker and prefix.
const cursors = new Map<string, Map<string, number>>();
let bullmqSeen = { test: undefined as string | undefined, ids: new Set<string>() };

interface KafkaSettings {
  brokers: string[];
  prefix: string;
  signingKey: string;
}

function settingsOf(app: INestApplication): KafkaSettings & { transport: string } {
  const config = app.get(ConfigService);
  return {
    transport: config.getOrThrow<string>('messaging.transport'),
    brokers: config.getOrThrow<string[]>('kafka.brokers'),
    prefix: config.getOrThrow<string>('kafka.prefix'),
    signingKey: config.getOrThrow<string>('messaging.signingKey'),
  };
}

/** Starts every test at what is already published, so it sees only its own messages. */
export function snapshotTransportBeforeEach(getApp: () => INestApplication): void {
  beforeEach(async () => {
    const app = getApp();
    const settings = settingsOf(app);
    if (settings.transport === 'kafka') {
      const watermarks = await withReader(settings.brokers, (reader) => highWatermarks(reader, settings.prefix));
      cursors.set(cursorKey(settings), new Map([...watermarks].map(([partition, { high }]) => [partition, high])));
    } else {
      const ids = new Set((await queuedJobs(app)).map((job) => job.id!));
      bullmqSeen = { test: currentTest(), ids };
    }
  });
}

export async function publishedEnvelopes(app: INestApplication): Promise<PublishedEvent[]> {
  const settings = settingsOf(app);
  return settings.transport === 'kafka' ? readKafka(settings) : readBullmq(app);
}

export async function deliverPublished(app: INestApplication): Promise<DeliveredEvent[]> {
  const delivery = app.get(ConsumerDelivery);
  const delivered: DeliveredEvent[] = [];
  for (const { consumer, envelope, unverified } of await publishedEnvelopes(app)) {
    const result = unverified ? 'unverified' : await delivery.deliver(consumer, envelope as DomainEventJob);
    delivered.push({ consumer, eventType: envelope?.eventType, outboxId: envelope?.outboxId, result });
  }
  return delivered;
}

/** For a spec that expects every delivery to apply: a parked failure throws, as it once did in the handler. */
export async function deliverApplied(app: INestApplication): Promise<DeliveredEvent[]> {
  const delivered = await deliverPublished(app);
  const failed = delivered.find(({ result }) => result !== 'processed' && result !== 'duplicate');
  if (failed) {
    throw new Error(`delivering ${failed.eventType} ${failed.outboxId} to ${failed.consumer} ended ${failed.result}`);
  }
  return delivered;
}

export interface RawMessage {
  topic: KafkaTopic;
  value: Buffer | string;
  key?: string;
  headers?: Record<string, Buffer | string>;
}

/** Produces past the relay and its signing, for what only someone else on the network would send. */
export async function produceRaw(app: INestApplication, { topic, value, key, headers }: RawMessage): Promise<void> {
  const { brokers, prefix } = settingsOf(app);
  const producer = createKafka({ brokers, clientId: 'e2e-raw-producer' }, pino({ level: 'warn' })).producer({
    kafkaJS: { acks: -1 },
  });
  await producer.connect();
  try {
    await producer.send({ topic: qualifiedTopic(prefix, topic), messages: [{ key, value, headers }] });
  } finally {
    await producer.disconnect();
  }
}

/** What the group has yet to commit past, summed over its partitions. Zero once it caught up. */
export async function consumerLag(app: INestApplication, consumer: ConsumerName): Promise<number> {
  const { brokers, prefix } = settingsOf(app);
  const topics = CONSUMER_GROUPS[consumer].map((topic) => qualifiedTopic(prefix, topic));
  const watermarks = await withReader(brokers, (reader) => highWatermarks(reader, prefix));
  const admin = createKafka({ brokers, clientId: 'e2e-lag-reader' }, pino({ level: 'warn' })).admin();
  await admin.connect();
  try {
    const committed = await admin.fetchOffsets({ groupId: groupIdFor(prefix, consumer), topics });
    let lag = 0;
    for (const topic of topics) {
      for (let partition = 0; partition < TOPIC_SPEC.numPartitions; partition += 1) {
        const { low, high } = watermarks.get(`${topic}:${partition}`)!;
        const offset = committed
          .find((entry) => entry.topic === topic)
          ?.partitions.find((entry) => entry.partition === partition)?.offset;
        const from = offset !== undefined && Number(offset) >= 0 ? Number(offset) : low;
        lag += high - from;
      }
    }
    return lag;
  } finally {
    await admin.disconnect();
  }
}

function cursorKey({ brokers, prefix }: KafkaSettings): string {
  return `${brokers.join(',')}|${prefix}`;
}

function currentTest(): string | undefined {
  return expect.getState().currentTestName;
}

async function readKafka(settings: KafkaSettings): Promise<PublishedEvent[]> {
  const key = cursorKey(settings);
  const cursor = cursors.get(key) ?? new Map<string, number>();
  cursors.set(key, cursor);

  const messages = await withReader(settings.brokers, async (reader) => {
    const watermarks = await highWatermarks(reader, settings.prefix);
    // A partition no snapshot has seen starts at the beginning of what the broker still holds.
    const pending = [...watermarks]
      .map(([partitionKey, { topic, partition, low, high }]) => ({
        partitionKey,
        topic,
        partition,
        from: cursor.get(partitionKey) ?? low,
        high,
      }))
      .filter(({ from, high }) => from < high);
    const read = await readRanges(reader, pending);
    for (const { partitionKey, high } of pending) cursor.set(partitionKey, high);
    return read;
  });

  const unprefixed = new Map(TOPICS.map(({ topic }) => [qualifiedTopic(settings.prefix, topic), topic]));
  return messages.map((message) => {
    const topic = unprefixed.get(message.topic)!;
    const headers: Record<string, Buffer | string> = Object.assign({}, ...(message.headers ?? []));
    const verdict = verifyInbound(settings.signingKey, topic, message.value, headers);
    const decoded = verdict.verified ? verdict.envelope : parseQuietly(message.value);
    return {
      consumer: consumerFor(topic),
      envelope: decoded,
      unverified: verdict.verified ? undefined : verdict.reason,
      record: {
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        key: message.key?.toString(),
        headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value.toString()])),
      },
    };
  });
}

async function readBullmq(app: INestApplication): Promise<PublishedEvent[]> {
  if (bullmqSeen.test !== currentTest()) bullmqSeen = { test: currentTest(), ids: new Set() };
  const fresh = (await queuedJobs(app)).filter((job) => !bullmqSeen.ids.has(job.id!));
  for (const job of fresh) bullmqSeen.ids.add(job.id!);
  return fresh.map((job) => ({ consumer: DOMAIN_EVENTS_CONSUMER, envelope: job.data }));
}

async function queuedJobs(app: INestApplication): Promise<Job<DomainEventJob>[]> {
  const queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
  const jobs = await queue.getJobs([...QUEUED_STATES]);
  return jobs.sort((a, b) => a.timestamp - b.timestamp || Number(a.id) - Number(b.id));
}

function parseQuietly(value: Buffer | null): DomainEventJob | undefined {
  try {
    return value ? (JSON.parse(value.toString('utf8')) as DomainEventJob) : undefined;
  } catch {
    return undefined;
  }
}

interface Watermark {
  topic: string;
  partition: number;
  low: number;
  high: number;
}

async function highWatermarks(reader: KafkaConsumer, prefix: string): Promise<Map<string, Watermark>> {
  const partitions = TOPICS.flatMap(({ topic }) =>
    Array.from({ length: TOPIC_SPEC.numPartitions }, (_, partition) => ({
      topic: qualifiedTopic(prefix, topic),
      partition,
    })),
  );
  const marks = await Promise.all(
    partitions.map(
      ({ topic, partition }) =>
        new Promise<Watermark>((resolve, reject) =>
          reader.queryWatermarkOffsets(topic, partition, BROKER_TIMEOUT_MS, (error, offsets) =>
            error
              ? reject(toError(error))
              : resolve({ topic, partition, low: offsets.lowOffset, high: offsets.highOffset }),
          ),
        ),
    ),
  );
  return new Map(marks.map((mark) => [`${mark.topic}:${mark.partition}`, mark]));
}

/**
 * Reads [from, high) of each partition, then interleaves the partitions by produce time: the order the
 * relay published in, without breaking the order within a partition that the consumers rely on.
 */
async function readRanges(
  reader: KafkaConsumer,
  ranges: Array<{ topic: string; partition: number; from: number; high: number }>,
): Promise<Message[]> {
  if (ranges.length === 0) return [];
  const byPartition = new Map(ranges.map((range) => [`${range.topic}:${range.partition}`, [] as Message[]]));
  const remaining = new Map(ranges.map((range) => [`${range.topic}:${range.partition}`, range.high]));
  reader.assign(ranges.map(({ topic, partition, from }) => ({ topic, partition, offset: from })));

  const deadline = Date.now() + READ_TIMEOUT_MS;
  while (remaining.size > 0) {
    if (Date.now() > deadline) throw new Error(`messages still unread after ${READ_TIMEOUT_MS}ms`);
    for (const message of await consumeBatch(reader)) {
      const partitionKey = `${message.topic}:${message.partition}`;
      const high = remaining.get(partitionKey);
      if (high === undefined || message.offset >= high) continue;
      byPartition.get(partitionKey)!.push(message);
      if (message.offset + 1 >= high) remaining.delete(partitionKey);
    }
  }
  return mergeByTimestamp([...byPartition.values()]);
}

function consumeBatch(reader: KafkaConsumer): Promise<Message[]> {
  return new Promise((resolve, reject) =>
    reader.consume(500, (error, messages) => (error ? reject(toError(error)) : resolve(messages))),
  );
}

function mergeByTimestamp(partitions: Message[][]): Message[] {
  const heads = partitions.map(() => 0);
  const merged: Message[] = [];
  for (;;) {
    let next = -1;
    for (const [index, messages] of partitions.entries()) {
      const head = messages[heads[index]];
      if (!head) continue;
      if (next === -1 || publishedBefore(head, partitions[next][heads[next]])) next = index;
    }
    if (next === -1) return merged;
    merged.push(partitions[next][heads[next]]);
    heads[next] += 1;
  }
}

// A batch's sends share a millisecond, and the relay sends its rows in outbox id order.
function publishedBefore(a: Message, b: Message): boolean {
  const [at, bt] = [a.timestamp ?? 0, b.timestamp ?? 0];
  return at !== bt ? at < bt : messageId(a) < messageId(b);
}

function messageId(message: Message): bigint {
  const header = message.headers?.find((entry) => 'message_id' in entry)?.message_id?.toString();
  return header && /^\d+$/.test(header) ? BigInt(header) : 0n;
}

/** A throwaway reader on a random group that never commits, so no consumer group sees it. */
async function withReader<T>(brokers: string[], read: (reader: KafkaConsumer) => Promise<T>): Promise<T> {
  const reader = new KafkaConsumer(
    {
      'metadata.broker.list': brokers.join(','),
      'group.id': `e2e.reader.${randomUUID()}`,
      'enable.auto.commit': false,
      'fetch.wait.max.ms': 50,
    },
    {},
  );
  reader.setDefaultConsumeTimeout(100);
  await new Promise<void>((resolve, reject) =>
    reader.connect({ timeout: BROKER_TIMEOUT_MS }, (error) => (error ? reject(toError(error)) : resolve())),
  );
  try {
    return await read(reader);
  } finally {
    await new Promise<void>((resolve) => reader.disconnect(() => resolve()));
  }
}
