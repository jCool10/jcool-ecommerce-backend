import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import type { DomainEventPublisher, OutboundEvent, PublishOutcome } from '../transport/domain-event-publisher.port';
import { createKafka } from './kafka-client.factory';
import { SIGNATURE_HEADER, signValue } from './kafka-message-signature';
import { qualifiedTopic, topicFor } from './kafka-topology';
import { abortableSleep, timeout } from './abortable-timers';

const LOG_CONTEXT = 'KafkaDomainEventPublisher';
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5_000;

export interface KafkaPublisherSettings {
  prefix: string;
  signingKey: string;
  deliveryTimeoutMs: number;
  /** How long ready() stays false after a batch the broker refused outright. */
  unreadyForMs: number;
}

/**
 * Connected means nothing once the broker dies: the client has no disconnect event and reconnects on
 * its own. A batch where every send failed is the signal instead, and it holds the relay off for a
 * reset window, which is what a breaker would do if the relay called often enough to trip one.
 */
export class KafkaDomainEventPublisher implements DomainEventPublisher, OnModuleInit, OnApplicationShutdown {
  private producer: KafkaJS.Producer | null = null;
  private connected = false;
  private unreadyUntil = 0;
  private readonly stopping = new AbortController();

  constructor(
    private readonly newProducer: () => KafkaJS.Producer,
    private readonly settings: KafkaPublisherSettings,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  // Not awaited: a broker that is down must not hold the api's boot.
  onModuleInit(): void {
    void this.connect();
  }

  ready(): boolean {
    return this.connected && Date.now() >= this.unreadyUntil;
  }

  async publish(events: OutboundEvent[]): Promise<PublishOutcome[]> {
    const producer = this.producer;
    if (!producer || !this.connected) {
      const error = new Error('Kafka producer is not connected');
      return events.map(({ rowId }) => ({ rowId, ok: false, error }));
    }

    const settled = new Map<string, PublishOutcome>();
    const sends: Promise<void>[] = [];
    for (const event of events) {
      let topic: string;
      try {
        topic = qualifiedTopic(this.settings.prefix, topicFor(event.eventType));
      } catch (error) {
        this.logger.error(
          { err: toError(error), outboxId: event.rowId, eventType: event.eventType },
          'outbox row has no Kafka topic',
        );
        settled.set(event.rowId, { rowId: event.rowId, ok: false, error: toError(error) });
        continue;
      }
      // One send per row so each gets its own outcome. The client queues them in call order, and the
      // idempotent producer keeps that order per partition with several requests in flight.
      sends.push(
        producer.send({ topic, messages: [this.message(event)] }).then(
          () => void settled.set(event.rowId, { rowId: event.rowId, ok: true }),
          (error: unknown) => void settled.set(event.rowId, { rowId: event.rowId, ok: false, error: toError(error) }),
        ),
      );
    }
    if (sends.length === 0) return events.map(({ rowId }) => settled.get(rowId)!);

    // message.timeout.ms bounds a send, but a lost broker can take up to twice that to reject it.
    const expiry = timeout(this.settings.deliveryTimeoutMs);
    await Promise.race([Promise.allSettled(sends), expiry.elapsed]);
    expiry.cancel();

    const unanswered = new Error(`no broker ack within ${this.settings.deliveryTimeoutMs}ms`);
    const outcomes = events.map(({ rowId }) => settled.get(rowId) ?? { rowId, ok: false, error: unanswered });
    if (!outcomes.some((outcome) => outcome.ok)) {
      this.unreadyUntil = Date.now() + this.settings.unreadyForMs;
      this.logger.warn({ unreadyForMs: this.settings.unreadyForMs }, 'Kafka refused the whole batch');
    }
    return outcomes;
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    const producer = this.producer;
    if (!producer) return;
    // Flushes what is still in flight. Bounded: a broker that is gone never acks it.
    const bound = timeout(DISCONNECT_TIMEOUT_MS);
    await Promise.race([
      producer.disconnect().catch((error: unknown) => {
        this.logger.error({ err: toError(error) }, 'failed to disconnect the Kafka producer');
      }),
      bound.elapsed,
    ]);
    bound.cancel();
  }

  private async connect(): Promise<void> {
    for (let delay = RECONNECT_FIRST_MS; !this.stopping.signal.aborted; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
      const producer = this.newProducer();
      this.producer = producer;
      try {
        await producer.connect();
        this.connected = true;
        this.logger.info('Kafka producer connected');
        return;
      } catch (error) {
        this.producer = null;
        if (this.stopping.signal.aborted) return;
        this.logger.error({ err: toError(error), retryInMs: delay }, 'Kafka producer failed to connect');
        await abortableSleep(delay, this.stopping.signal);
      }
    }
  }

  private message({ rowId, eventType, aggregateId, envelope }: OutboundEvent): KafkaJS.Message {
    // Serialised once, so the signature covers exactly the bytes on the wire.
    const value = Buffer.from(JSON.stringify(envelope));
    const headers: KafkaJS.IHeaders = { message_id: rowId, event_type: eventType };
    if (envelope.traceparent) headers.traceparent = envelope.traceparent;
    headers[SIGNATURE_HEADER] = signValue(this.settings.signingKey, value);
    return { key: aggregateId, value, headers };
  }
}

export function kafkaDomainEventPublisherFrom(config: ConfigService, logger: PinoLogger): KafkaDomainEventPublisher {
  const kafka = createKafka(
    { brokers: config.getOrThrow<string[]>('kafka.brokers'), clientId: config.getOrThrow<string>('kafka.clientId') },
    logger,
  );
  const deliveryTimeoutMs = config.getOrThrow<number>('kafka.deliveryTimeoutMs');
  return new KafkaDomainEventPublisher(
    // message.timeout.ms, not kafkaJS.timeout: only the former bounds a send.
    () => kafka.producer({ kafkaJS: { idempotent: true, acks: -1 }, 'message.timeout.ms': deliveryTimeoutMs }),
    {
      prefix: config.getOrThrow<string>('kafka.prefix'),
      signingKey: config.getOrThrow<string>('messaging.signingKey'),
      deliveryTimeoutMs,
      unreadyForMs: config.getOrThrow<number>('resilience.breaker.resetTimeoutMs'),
    },
    logger,
  );
}
