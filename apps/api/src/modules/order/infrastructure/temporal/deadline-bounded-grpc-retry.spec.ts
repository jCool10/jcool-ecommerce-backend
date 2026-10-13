import type { GrpcRetryOptions } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { deadlineBoundedRetryOptions } from './deadline-bounded-grpc-retry';

type Status = Parameters<GrpcRetryOptions['retryableDecider']>[1];

const NOW = 1_000_000;
const unavailable = { code: 14, details: 'connect ECONNREFUSED' } as Status;
const invalidArgument = { code: 3, details: 'bad request' } as Status;

describe('deadlineBoundedRetryOptions', () => {
  it('retries an unavailable server while the backoff still ends inside the deadline', () => {
    const options = deadlineBoundedRetryOptions(NOW + 60_000, () => NOW);

    expect(options.retryableDecider(1, unavailable)).toBe(true);
    const delay = options.delayFunction(1, unavailable);
    expect(delay).toBeGreaterThan(0);
    expect(options.delayFunction(1, unavailable)).toBe(delay);
  });

  it('hands the failure back once the next backoff would end past the deadline', () => {
    const options = deadlineBoundedRetryOptions(NOW + 1, () => NOW);

    expect(options.retryableDecider(1, unavailable)).toBe(false);
  });

  it('keeps the default refusal of a status not worth retrying', () => {
    const options = deadlineBoundedRetryOptions(Infinity, () => NOW);

    expect(options.retryableDecider(1, invalidArgument)).toBe(false);
  });

  it('keeps the default attempt cap when the call has no deadline', () => {
    const options = deadlineBoundedRetryOptions(Infinity, () => NOW);

    expect(options.retryableDecider(9, unavailable)).toBe(true);
    expect(options.retryableDecider(10, unavailable)).toBe(false);
  });
});
