import { sleep } from './sleep';

const POLL_MS = 50;

/** Polls `read` until `done` holds; the error carries the last value so a timeout says where it stopped. */
export async function eventually<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`condition not met in ${timeoutMs}ms; last value ${JSON.stringify(value)}`);
    }
    await sleep(POLL_MS);
  }
}
