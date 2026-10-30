import { basename } from 'node:path';
import { expect } from 'vitest';

/** One queue per spec file and vitest worker, so no two files ever poll each other's tasks. */
export function temporalTaskQueueForCurrentSpec(suffix?: string): string {
  const testPath = expect.getState().testPath;
  const spec = testPath ? basename(testPath, '.e2e-spec.ts') : 'unknown';
  const queue = `checkout-saga-w${process.env.VITEST_POOL_ID ?? '0'}-${spec}`;
  return suffix ? `${queue}-${suffix}` : queue;
}
