import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { describe, expect, it } from 'vitest';
import type { MessagingDb } from '../messaging.database';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import { MIN_INBOX_RETENTION_DAYS } from '../queue/queue-options';
import { SweepInbox } from './sweep-inbox';

const build = (days: number) =>
  new SweepInbox({} as MessagingDb, fakeConfigService({ 'retention.inboxDays': days }), new RetentionSweepRegistry());

describe('SweepInbox', () => {
  // A claim swept while the queue can still redeliver its message lets the effect run twice.
  it('refuses to boot on a window shorter than the failed-job horizon', () => {
    expect(() => build(MIN_INBOX_RETENTION_DAYS - 1)).toThrow(`at least ${MIN_INBOX_RETENTION_DAYS} days`);
    expect(() => build(MIN_INBOX_RETENTION_DAYS)).not.toThrow();
  });
});
