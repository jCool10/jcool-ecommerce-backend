/**
 * Real elapsed time, deliberately: the suites that use this are waiting on a TTL, a lease or a
 * rolling window that Redis and Postgres keep by wall clock, so a fake timer would advance the test
 * without advancing what it is waiting for.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
