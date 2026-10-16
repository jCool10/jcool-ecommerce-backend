import { describe, expect, it } from 'vitest';
import { sampleId } from '@shared/testing/id-generator.double';
import { type DomainEventJob, isWellFormedEnvelope } from './domain-event.job';

const envelope = (outboxId: string): DomainEventJob => ({
  outboxId,
  aggregateType: 'Order',
  aggregateId: sampleId(1),
  eventType: 'order.placed',
  payload: {},
  occurredAt: '2026-09-01T00:00:00.000Z',
  traceparent: null,
});

describe('isWellFormedEnvelope', () => {
  it('accepts an outbox id and refuses anything that is not one', () => {
    expect(isWellFormedEnvelope(envelope(sampleId()))).toBe(true);
    for (const outboxId of ['', '42', '0198f0d8-0000-7000-8000-000000000001', `${sampleId()}' OR '1'='1`]) {
      expect(isWellFormedEnvelope(envelope(outboxId))).toBe(false);
    }
  });

  // The type picks the retry ladder, so a truthy non-string would fail on its first retry instead of here.
  it('refuses an event type that is not a non-empty string', () => {
    for (const eventType of ['', 42, { name: 'order.placed' }]) {
      expect(isWellFormedEnvelope({ ...envelope(sampleId()), eventType } as unknown as DomainEventJob)).toBe(false);
    }
  });
});
