import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { PermanentError, UnhandledEventError } from './errors';

// BullMQ skips the retry budget only for an UnrecoverableError, matched on the prototype chain.
describe('messaging errors', () => {
  it('marks permanent failures as ones the transport will not retry', () => {
    expect(new PermanentError('bad envelope')).toBeInstanceOf(UnrecoverableError);
    expect(new UnhandledEventError('payment.succeeded')).toBeInstanceOf(UnrecoverableError);
  });
});
