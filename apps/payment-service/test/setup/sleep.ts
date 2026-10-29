/**
 * Real elapsed time, deliberately: what these suites wait on (a breaker's reset window, a scheduler's
 * interval) runs by wall clock, so a fake timer would advance the test without advancing it.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
