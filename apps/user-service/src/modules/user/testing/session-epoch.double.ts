import type { SessionEpochPort, SessionEpochPublisherPort } from '../application/ports';

/** The stored epochs; `bump` fails with `bumpError` when set. `log` orders calls across fakes. */
export class FakeSessionEpoch implements SessionEpochPort {
  readonly epochs = new Map<string, number>();
  bumpError?: Error;

  constructor(readonly log: string[] = []) {}

  current(userId: string): Promise<number | null> {
    return Promise.resolve(this.epochs.get(userId) ?? null);
  }

  bump(userId: string): Promise<number> {
    this.log.push('bump');
    if (this.bumpError) return Promise.reject(this.bumpError);
    const next = (this.epochs.get(userId) ?? 0) + 1;
    this.epochs.set(userId, next);
    return Promise.resolve(next);
  }
}

/** Publishes as the Redis script does, never lowering a value; fails for the users in `failFor`. */
export class FakeSessionEpochPublisher implements SessionEpochPublisherPort {
  readonly published = new Map<string, number>();
  readonly failFor = new Set<string>();

  publish(userId: string, epoch: number): Promise<number> {
    if (this.failFor.has(userId)) return Promise.reject(new Error('Connection is closed.'));
    const next = Math.max(this.published.get(userId) ?? 0, epoch);
    this.published.set(userId, next);
    return Promise.resolve(next);
  }
}
