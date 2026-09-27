import { describe, expect, it } from 'vitest';
import { sampleId } from '@shared/testing/id-generator.double';
import { type DomainEventJob, isWellFormedEnvelope, jobIdFor } from './domain-event.job';

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
});

describe('jobIdFor', () => {
  // BullMQ refuses a custom id that reads back as an integer or carries a colon, and an outbox id is
  // all digits.
  it('gives BullMQ an id it accepts, one per message', () => {
    const ids = Array.from({ length: 64 }, (_, n) => sampleId(n));

    const jobIds = ids.map(jobIdFor);

    for (const jobId of jobIds) {
      expect(jobId).not.toMatch(/^\d+$/);
      expect(jobId).not.toContain(':');
    }
    expect(new Set(jobIds).size).toBe(ids.length);
  });
});
