import { MAX_REDELIVERY_AGE_SEC } from '../retry/retry-policy';

export const TOPICS = [
  { topic: 'order.events', eventPrefix: 'order' },
  { topic: 'payment.events', eventPrefix: 'payment' },
  { topic: 'catalog.events', eventPrefix: 'catalog' },
] as const;

export type KafkaTopic = (typeof TOPICS)[number]['topic'];

// Keys are also the `consumer` written to inbox and consumer_retries, so they carry no prefix.
export const CONSUMER_GROUPS = {
  'domain-events': ['order.events', 'payment.events'],
  'catalog-search': ['catalog.events'],
} as const satisfies Record<string, readonly KafkaTopic[]>;

export type ConsumerName = keyof typeof CONSUMER_GROUPS;

// Lands in topic names and group ids, which Kafka limits to these characters.
export const KAFKA_PREFIX_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

const SEGMENT_MS = 3_600_000;

export const TOPIC_SPEC = {
  numPartitions: 3,
  configs: {
    'cleanup.policy': 'delete',
    // Kafka deletes whole segments, and only on its retention check (every 5 minutes by default), so a
    // record lives up to retention.ms + segment.ms plus that interval.
    'retention.ms': String(MAX_REDELIVERY_AGE_SEC * 1000 - SEGMENT_MS),
    'segment.ms': String(SEGMENT_MS),
    'min.insync.replicas': '1',
    // One replica: without an fsync per write, a host crash loses what sat in the page cache.
    'flush.messages': '1',
  },
} as const;

export class UnroutableEventError extends Error {
  constructor(readonly eventType: string) {
    super(`No Kafka topic for event type "${eventType}"`);
    this.name = 'UnroutableEventError';
  }
}

export function topicFor(eventType: string): KafkaTopic {
  const dot = eventType.indexOf('.');
  const match = dot > 0 && TOPICS.find((entry) => entry.eventPrefix === eventType.slice(0, dot));
  if (!match) throw new UnroutableEventError(eventType);
  return match.topic;
}

export function qualifiedTopic(prefix: string, topic: KafkaTopic): string {
  return `${prefix}.${topic}`;
}

export function groupIdFor(prefix: string, consumer: string): string {
  return `${prefix}.${consumer}`;
}
