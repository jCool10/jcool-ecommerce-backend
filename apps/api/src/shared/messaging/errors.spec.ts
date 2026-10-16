import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { PermanentError, UnhandledEventError } from './errors';

// Handler errors stop at the retry store now, so permanence is decided by our own type alone.
describe('messaging errors', () => {
  it('tells a permanent failure apart by its own type, not the transport one', () => {
    const unhandled = new UnhandledEventError('payment.succeeded');

    expect(unhandled).toBeInstanceOf(PermanentError);
    expect(unhandled).not.toBeInstanceOf(UnrecoverableError);
    expect(new PermanentError('bad envelope')).not.toBeInstanceOf(UnrecoverableError);
  });
});
