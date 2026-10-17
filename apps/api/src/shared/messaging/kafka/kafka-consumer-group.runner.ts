import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import type { MetricsPort } from '@jcool/metrics-port';
import { runInJobContext } from '@jcool/platform/observability';
import type { ConsumerDelivery } from '../consume/consumer-delivery';
import type { DomainEventJob } from '../queue/domain-event.job';
import { abortableSleep, timeout } from './abortable-timers';
import { hasValidSignature, SIGNATURE_HEADER } from './kafka-message-signature';
import {
  CONSUMER_GROUPS,
  groupIdFor,
  qualifiedTopic,
  topicFor,
  type ConsumerName,
  type KafkaTopic,
} from './kafka-topology';

const FIRST_REDELIVERY_WAIT_MS = 500;
const MAX_REDELIVERY_WAIT_MS = 30_000;
const FIRST_RESTART_WAIT_MS = 1_000;
const MAX_RESTART_WAIT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;

/** Fixed metric label: what an unverified message claims to be is not worth a label. */
export const UNVERIFIED_EVENT_LABEL = 'unverified';

export type UnverifiedReason = 'missing_signature' | 'bad_signature' | 'topic_mismatch';

export type InboundVerdict =
  { verified: true; envelope: DomainEventJob | undefined } | { verified: false; reason: UnverifiedReason };

export interface ConsumerGroupSettings {
  prefix: string;
  signingKey: string;
}

/**
 * Checks the signature on the raw bytes before anything parses them. A signed value that is not JSON is
 * ours and broken, so it goes on as undefined and the delivery files it as dead. `topic` is unprefixed;
 * undefined for a topic the group does not read.
 */
export function verifyInbound(
  signingKey: string,
  topic: KafkaTopic | undefined,
  value: Buffer | null,
  headers: KafkaJS.IHeaders | undefined,
): InboundVerdict {
  const signature = headers?.[SIGNATURE_HEADER];
  if (signature === undefined) return { verified: false, reason: 'missing_signature' };
  if (!value || Array.isArray(signature) || !hasValidSignature(signingKey, value, Buffer.from(signature))) {
    return { verified: false, reason: 'bad_signature' };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(value.toString('utf8'));
  } catch {
    return { verified: true, envelope: undefined };
  }
  // Also what keeps a signed but malformed envelope from reaching a retry row it would fail to write.
  const eventType = (envelope as { eventType?: unknown } | null)?.eventType;
  if (topic === undefined || typeof eventType !== 'string' || routedTopic(eventType) !== topic) {
    return { verified: false, reason: 'topic_mismatch' };
  }
  return { verified: true, envelope: envelope as DomainEventJob };
}

function routedTopic(eventType: string): KafkaTopic | undefined {
  try {
    return topicFor(eventType);
  } catch {
    return undefined;
  }
}

/** One consumer group. Every message is committed once its outcome is durable, one partition at a time. */
export class KafkaConsumerGroupRunner {
  private readonly topics: ReadonlyMap<string, KafkaTopic>;
  private readonly shutdown = new AbortController();
  private readonly redeliveryWaitMs = new Map<string, number>();
  private consumer: KafkaJS.Consumer | null = null;
  private joined = false;

  constructor(
    readonly name: ConsumerName,
    private readonly newConsumer: (config: KafkaJS.ConsumerConstructorConfig) => KafkaJS.Consumer,
    private readonly settings: ConsumerGroupSettings,
    private readonly delivery: ConsumerDelivery,
    private readonly cls: ClsService,
    private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.topics = new Map(CONSUMER_GROUPS[name].map((topic) => [qualifiedTopic(settings.prefix, topic), topic]));
  }

  get groupId(): string {
    return groupIdFor(this.settings.prefix, this.name);
  }

  get subscribedTopics(): string[] {
    return [...this.topics.keys()];
  }

  /** Returns at once: a broker that is not up yet must not hold the boot. */
  start(): void {
    void this.startUntilRunning();
  }

  /** True once the broker has assigned this member partitions, at least once. */
  hasJoined(): boolean {
    return this.joined;
  }

  assignment(): KafkaJS.TopicPartition[] {
    try {
      return this.consumer?.assignment() ?? [];
    } catch {
      // The client refuses to answer unless connected, and a member that is not connected holds nothing.
      return [];
    }
  }

  async stop(): Promise<void> {
    // First, so a partition waiting out its backoff lets go instead of holding the disconnect.
    this.shutdown.abort();
    const consumer = this.consumer;
    if (!consumer) return;

    const limit = timeout(CLOSE_TIMEOUT_MS);
    const closed = consumer.disconnect().then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ err: error, group: this.name }, 'Kafka consumer disconnect failed');
        return true;
      },
    );
    try {
      const done = await Promise.race([closed, limit.elapsed.then(() => false)]);
      if (!done)
        this.logger.warn(
          { group: this.name, timeoutMs: CLOSE_TIMEOUT_MS },
          'Kafka consumer did not disconnect in time',
        );
    } finally {
      limit.cancel();
    }
  }

  private async startUntilRunning(): Promise<void> {
    for (let attempt = 0; !this.shutdown.signal.aborted; attempt += 1) {
      // A consumer whose connect gave up stays disconnected for good, so every attempt gets a new one.
      const consumer = this.newConsumer(this.consumerConfig());
      this.consumer = consumer;
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: this.subscribedTopics });
        await consumer.run({
          partitionsConsumedConcurrently: 1,
          eachMessage: (payload) => this.handle(consumer, payload),
        });
        return;
      } catch (error) {
        if (this.shutdown.signal.aborted) return;
        this.logger.error(
          { err: toError(error), group: this.name, attempt },
          'Kafka consumer failed to start, retrying',
        );
        await consumer.disconnect().catch(() => undefined);
        await abortableSleep(Math.min(MAX_RESTART_WAIT_MS, FIRST_RESTART_WAIT_MS * 2 ** attempt), this.shutdown.signal);
      }
    }
  }

  private consumerConfig(): KafkaJS.ConsumerConstructorConfig {
    return {
      kafkaJS: { groupId: this.groupId, autoCommit: false, fromBeginning: true },
      'group.protocol': 'consumer',
      // Returning nothing leaves the client's own assign and revoke in place.
      rebalance_cb: (error: { code: number }, assignment: KafkaJS.TopicPartition[]) =>
        this.onRebalance(error, assignment),
    };
  }

  private onRebalance(error: { code: number }, assignment: KafkaJS.TopicPartition[]): void {
    const partitions = assignment.map(({ topic, partition }) => `${topic}:${partition}`);
    if (error.code === KafkaJS.ErrorCodes.ERR__ASSIGN_PARTITIONS) {
      this.joined = true;
      this.logger.info({ group: this.name, partitions }, 'Kafka partitions assigned');
    } else if (error.code === KafkaJS.ErrorCodes.ERR__REVOKE_PARTITIONS) {
      this.logger.info({ group: this.name, partitions }, 'Kafka partitions revoked');
    }
  }

  private async handle(consumer: KafkaJS.Consumer, { topic, partition, message }: KafkaJS.EachMessagePayload) {
    const verdict = verifyInbound(this.settings.signingKey, this.topics.get(topic), message.value, message.headers);
    if (verdict.verified) {
      await this.deliver(`${topic}:${partition}`, verdict.envelope);
    } else {
      // Never the value: whoever forged it chose what is in there.
      this.logger.warn(
        { topic, partition, offset: message.offset, reason: verdict.reason },
        'dropped an unverified Kafka message',
      );
      this.metrics.recordDeadLetter(UNVERIFIED_EVENT_LABEL, 'permanent');
    }
    // Offsets pass 2^53 long before they run out, hence the BigInt.
    await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
    this.redeliveryWaitMs.delete(`${topic}:${partition}`);
  }

  /**
   * Throws only when not even a retry row could be written. The client then redelivers the same offset,
   * and without the wait it would do so in a hot loop, re-running each handler's side effects.
   */
  private async deliver(partitionKey: string, envelope: DomainEventJob | undefined): Promise<void> {
    try {
      await runInJobContext(this.cls, `${this.name}:${envelope?.eventType ?? 'undecodable'}`, () =>
        // An undefined envelope fails the processor's envelope check and is filed as dead.
        this.delivery.deliver(this.name, envelope as DomainEventJob),
      );
    } catch (error) {
      const waitMs = this.redeliveryWaitMs.get(partitionKey) ?? FIRST_REDELIVERY_WAIT_MS;
      this.redeliveryWaitMs.set(partitionKey, Math.min(MAX_REDELIVERY_WAIT_MS, waitMs * 2));
      await abortableSleep(waitMs, this.shutdown.signal);
      throw error;
    }
  }
}
