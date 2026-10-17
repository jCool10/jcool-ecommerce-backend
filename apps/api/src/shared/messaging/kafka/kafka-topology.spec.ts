import { describe, expect, it } from 'vitest';
import { OrderCancelledEvent } from '@modules/order/domain/events/order-cancelled.event';
import { OrderExpiredEvent } from '@modules/order/domain/events/order-expired.event';
import { OrderFailedEvent } from '@modules/order/domain/events/order-failed.event';
import { OrderPaidEvent } from '@modules/order/domain/events/order-paid.event';
import { OrderPlacedEvent } from '@modules/order/domain/events/order-placed.event';
import { toFinalizedOutboxRecord, toPlacedOutboxRecord } from '@modules/order/application/order-outbox.mapper';
import { toSettledOutboxRecord } from '@modules/payment/application/payment-outbox.mapper';
import { PaymentStatus } from '@modules/payment/domain/payment-status';
import {
  toCategoryRenamedRecord,
  toProductChangedRecord,
} from '@modules/product/application/catalog/catalog-outbox.mapper';
import { MAX_REDELIVERY_AGE_SEC } from '../retry/retry-policy';
import {
  CONSUMER_GROUPS,
  TOPICS,
  TOPIC_SPEC,
  UnroutableEventError,
  groupIdFor,
  qualifiedTopic,
  topicFor,
} from './kafka-topology';

const at = new Date('2026-10-16T00:00:00Z');

// Built through the mappers the outbox writers call, so a new event type shows up here without
// anyone remembering to list it.
const emittedEventTypes = [
  toPlacedOutboxRecord(new OrderPlacedEvent('1', '2', 100, 'VND', at)),
  toFinalizedOutboxRecord(new OrderPaidEvent('1', '2', 100, 'VND', 'pi_1', at)),
  toFinalizedOutboxRecord(new OrderFailedEvent('1', '2', null, at)),
  toFinalizedOutboxRecord(new OrderExpiredEvent('1', '2', null, at)),
  toFinalizedOutboxRecord(new OrderCancelledEvent('1', '2', null, at)),
  ...[PaymentStatus.SUCCEEDED, PaymentStatus.FAILED].map((status) =>
    toSettledOutboxRecord({ paymentId: '3', orderId: '1', status, paymentRef: null, settledAt: at }),
  ),
  toProductChangedRecord('4'),
  toCategoryRenamedRecord('5'),
].map((record) => record.eventType);

// Kafka's own limits on topic and group names.
const KAFKA_NAME = /^[a-zA-Z0-9._-]{1,249}$/;

describe('kafka topology', () => {
  it('routes every event type the outbox can emit to a topic some consumer group reads', () => {
    const consumed = new Set(Object.values(CONSUMER_GROUPS).flat());

    for (const eventType of emittedEventTypes) {
      expect(consumed.has(topicFor(eventType)), eventType).toBe(true);
    }
  });

  it('routes on the prefix before the first dot', () => {
    expect(topicFor('order.paid')).toBe('order.events');
    expect(topicFor('payment.failed')).toBe('payment.events');
    expect(topicFor('catalog.product.changed')).toBe('catalog.events');
  });

  it('refuses an event type whose prefix has no topic', () => {
    for (const eventType of ['refund.issued', 'order', 'orderx', '.paid', '', 'orders.placed']) {
      expect(() => topicFor(eventType), JSON.stringify(eventType)).toThrow(UnroutableEventError);
    }
  });

  it('gives catalog events a group of their own, so a slow search engine never holds up an order', () => {
    expect(CONSUMER_GROUPS).toEqual({
      'domain-events': ['order.events', 'payment.events'],
      'catalog-search': ['catalog.events'],
    });
  });

  it('reads every topic from exactly one group', () => {
    const subscribed = Object.values(CONSUMER_GROUPS).flat();

    expect([...subscribed].sort()).toEqual(TOPICS.map((t) => t.topic).sort());
  });

  it('prefixes topics and group ids, never the consumer name', () => {
    expect(qualifiedTopic('jcool', 'order.events')).toBe('jcool.order.events');
    expect(groupIdFor('jcool', 'catalog-search')).toBe('jcool.catalog-search');

    for (const { topic } of TOPICS) expect(qualifiedTopic('e2e.kafka-topology', topic)).toMatch(KAFKA_NAME);
    for (const consumer of Object.keys(CONSUMER_GROUPS)) {
      expect(groupIdFor('e2e.kafka-topology', consumer)).toMatch(KAFKA_NAME);
    }
  });

  it('keeps a record no longer than a delivered message can still come back', () => {
    const { configs } = TOPIC_SPEC;

    // Kafka deletes whole segments, so a record outlives retention.ms by up to one segment.
    expect(configs['segment.ms']).toBe('3600000');
    expect(Number(configs['retention.ms']) + Number(configs['segment.ms'])).toBe(MAX_REDELIVERY_AGE_SEC * 1000);
    expect(configs['retention.ms']).toBe('601200000');
  });

  it('lays every topic out as three partitions on one fsynced replica', () => {
    expect(TOPIC_SPEC.numPartitions).toBe(3);
    expect(TOPIC_SPEC.configs).toMatchObject({
      'cleanup.policy': 'delete',
      'min.insync.replicas': '1',
      'flush.messages': '1',
    });
    // Strings, so a drift check compares them with what describeConfigs returns as-is.
    for (const value of Object.values(TOPIC_SPEC.configs)) expect(typeof value).toBe('string');
  });
});
