import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// Sweeps are driven directly, since a timer tick would race the test.
describe('Retention sweeps (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let registry: RetentionSweepRegistry;

  const sweepNamed = (name: string): RetentionSweep => {
    const sweep = registry.all().find((s) => s.name === name);
    if (!sweep) throw new Error(`no retention sweep named "${name}"`);
    return sweep;
  };

  const webhookRow = (providerEventId: string, receivedAt: Date) => ({
    id: testId(),
    provider: 'stripe',
    providerEventId,
    type: 'payment_intent.succeeded',
    payload: { id: providerEventId },
    receivedAt,
  });

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ RETENTION_WEBHOOK_EVENT_DAYS: '14' }));
    registry = app.get(RetentionSweepRegistry);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // A sweep that was never registered produces no error and no metric; the table just grows.
  it('registers a sweep for every table with a retention rule', () => {
    expect([...registry.names()].sort()).toEqual(['messaging:outbox', 'payment:webhook-events']);
  });

  describe('payment:webhook-events', () => {
    // The window is the gateway's redelivery window, not the queue's: the unique
    // (provider, provider_event_id) turns a repeat into a no-op at ingress.
    it('keeps an event the gateway could still redeliver', async () => {
      await db
        .insert(schema.webhookEvents)
        .values([webhookRow('evt_old', daysAgo(15)), webhookRow('evt_recent', daysAgo(13))]);

      const deleted = await sweepNamed('payment:webhook-events').sweep(500);

      expect(deleted).toBe(1);
      const left = await db
        .select({ providerEventId: schema.webhookEvents.providerEventId })
        .from(schema.webhookEvents);
      expect(left).toEqual([{ providerEventId: 'evt_recent' }]);
    });
  });
});
