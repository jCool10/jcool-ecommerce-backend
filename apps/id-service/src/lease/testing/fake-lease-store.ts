import type { LeaseGrant, LeaseStore } from '@jcool/id-generator';

type AcquireRequest = Parameters<LeaseStore['acquire']>[0];
type RenewRequest = Parameters<LeaseStore['renew']>[0];
type ReleaseRequest = Parameters<LeaseStore['release']>[0];
type AcquireAnswer = { nodeId: number; floorMs: number | null } | null | Error;

/**
 * Acquire answers from a script (a grant, an exhausted pool, or a failure), then keeps reporting the
 * pool exhausted. Grants and renewals are stamped with the store's `now` at the moment they answer.
 */
export class FakeLeaseStore implements LeaseStore {
  readonly acquisitions: number[] = [];
  readonly renewals: RenewRequest[] = [];
  readonly releases: ReleaseRequest[] = [];
  renewResult: boolean | Error | Promise<boolean> = true;
  releaseResult: Error | null = null;
  private readonly answers: AcquireAnswer[] = [];
  private generation = 0;

  constructor(private readonly nowMs: () => number = Date.now) {}

  grant(nodeId: number, floorMs: number | null = null): this {
    this.answers.push({ nodeId, floorMs });
    return this;
  }

  exhausted(): this {
    this.answers.push(null);
    return this;
  }

  fail(error: Error): this {
    this.answers.push(error);
    return this;
  }

  acquire(request: AcquireRequest): Promise<LeaseGrant | null> {
    const dbNowMs = this.nowMs();
    this.acquisitions.push(dbNowMs);
    const answer = this.answers.shift() ?? null;
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === null) return Promise.resolve(null);
    return Promise.resolve({
      ...answer,
      generation: ++this.generation,
      prevUntilMs: 0,
      leaseUntilMs: dbNowMs + request.ttlMs,
      dbNowMs,
    });
  }

  async renew(request: RenewRequest): Promise<number | null> {
    this.renewals.push(request);
    if (this.renewResult instanceof Error) throw this.renewResult;
    return (await this.renewResult) ? this.nowMs() + request.ttlMs : null;
  }

  release(request: ReleaseRequest): Promise<void> {
    this.releases.push(request);
    return this.releaseResult === null ? Promise.resolve() : Promise.reject(this.releaseResult);
  }
}
