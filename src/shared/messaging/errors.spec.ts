import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { PermanentError, UnhandledEventError } from './errors';

/**
 * The retry budget is skipped by BullMQ itself, not by anything in this package: `Job.shouldRetryJob`
 * tests `err instanceof UnrecoverableError || err.name === 'UnrecoverableError'`. The prototype chain
 * is the half this code relies on, so it is pinned here — an upgrade that broke it would otherwise
 * show up as five pointless retries of an unparseable message rather than as a failing test.
 */
describe('messaging errors', () => {
  it('marks a permanent failure in the form the transport checks for', () => {
    const error = new PermanentError('bad envelope');

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad envelope');
    // Kept specific on purpose: the name is what a human reads, and it is not what BullMQ matches on
    // here. See the note on PermanentError for the condition that would change that.
    expect(error.name).toBe('PermanentError');
  });

  it('treats a missing handler as permanent — no handler appears inside a retry budget', () => {
    const error = new UnhandledEventError('payment.succeeded');

    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.eventType).toBe('payment.succeeded');
  });
});
