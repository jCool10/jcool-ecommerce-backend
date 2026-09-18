export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls on real time: what the specs wait on (a lease, a fence) is kept by wall clock. */
export async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(everyMs);
  }
}
