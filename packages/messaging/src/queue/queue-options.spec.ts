import {
  MIN_INBOX_RETENTION_DAYS,
  REMOVE_ON_FAIL_AGE_SEC,
  buildJobOptions,
  cappedBackoffMs,
  retryHorizonMs,
} from './queue-options';

describe('retry ladders', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5].map((n) => cappedBackoffMs(n, 1_000, 5_000))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  it('sums every wait before the last attempt', () => {
    expect(retryHorizonMs(4, (n) => 1_000 * 2 ** (n - 1))).toBe(7_000);
    expect(retryHorizonMs(1, () => 1_000)).toBe(0);
  });
});

describe('queue defaults', () => {
  it('keeps a failed job exactly as long as the inbox must keep its claim', () => {
    expect(buildJobOptions(8, 1_000)).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnFail: { age: REMOVE_ON_FAIL_AGE_SEC },
    });
    expect(MIN_INBOX_RETENTION_DAYS * 86_400).toBeGreaterThanOrEqual(REMOVE_ON_FAIL_AGE_SEC);
  });
});
