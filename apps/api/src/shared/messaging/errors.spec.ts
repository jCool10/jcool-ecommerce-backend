import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { PermanentError, UnhandledEventError } from './errors';

// Pins the prototype chain that BullMQ's `Job.shouldRetryJob` matches on: an upgrade that broke it
// would otherwise show up as pointless retries of an unparseable message, not as a failing test.
describe('messaging errors', () => {
  it('marks a permanent failure in the form the transport checks for', () => {
    const error = new PermanentError('bad envelope');

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad envelope');
    expect(error.name).toBe('PermanentError');
  });

  it('treats a missing handler as permanent — no handler appears inside a retry budget', () => {
    const error = new UnhandledEventError('payment.succeeded');

    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.eventType).toBe('payment.succeeded');
  });
});
