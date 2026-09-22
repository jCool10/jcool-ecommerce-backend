import { decode } from '@jcool/id-codec';
import { LeaseNotHeldError } from './identity.errors';
import type { LeaseGrant, LeaseStore } from './lease-store.port';
import { NodeLease, type NodeLeaseOptions } from './node-lease';
import type { IdentityClock } from './snowflake.generator';

// Well after EPOCH_MS (2026-01-01): the earliest instant the layout can stamp is EPOCH_MS + 1.
const START_MS = 1_800_000_000_000;
const TTL_MS = 300_000;
const FENCE_MARGIN_MS = 15_000;
const QUARANTINE_MS = 10_000;
const HOLDER = 'replica-a/host/1';
const BUCKET = 42;

interface FakeClock {
  clock: IdentityClock;
  /** The same wall time, read from outside the process (a store stamping in real time). */
  realMs: () => number;
  advance(ms: number): void;
  /** A suspended host: the wall clock moves on while the monotonic clock stood still. */
  stepWallBy(ms: number): void;
  /** A process frozen right after its next `reads` clock reads, for `ms` on both clocks. */
  pauseAfter(reads: number, ms: number): void;
}

function fakeClock(): FakeClock {
  let wall = START_MS;
  let monotonic = 0;
  let elapsed = 0n;
  let pause: { reads: number; ms: number } | null = null;
  const advance = (ms: number) => {
    wall += ms;
    monotonic += ms;
  };
  const read = (value: number) => {
    if (pause !== null && --pause.reads === 0) {
      advance(pause.ms);
      pause = null;
    }
    return value;
  };
  return {
    clock: {
      wallMs: () => read(wall),
      monotonicMs: () => read(monotonic),
      elapsedNs: () => (elapsed += 1_000n),
    },
    realMs: () => wall,
    advance,
    stepWallBy: (ms) => {
      wall += ms;
    },
    pauseAfter: (reads, ms) => {
      pause = { reads, ms };
    },
  };
}

type AcquireRequest = Parameters<LeaseStore['acquire']>[0];
type RenewRequest = Parameters<LeaseStore['renew']>[0];
type ReleaseRequest = Parameters<LeaseStore['release']>[0];
type ScriptedGrant = Pick<LeaseGrant, 'nodeId' | 'floorMs' | 'prevUntilMs'> & { dbNowMs?: number };

/** `nowMs` is the database's clock: it stamps grants and the lease end a renew answers with. */
class FakeLeaseStore implements LeaseStore {
  readonly grants: (ScriptedGrant | null)[] = [];
  readonly renewals: RenewRequest[] = [];
  readonly releases: ReleaseRequest[] = [];
  renewResult: boolean | Error = true;
  private generation = 0;

  constructor(private readonly nowMs: () => number = () => START_MS) {}

  grant(
    nodeId: number,
    { floorMs = null, prevUntilMs = 0, dbNowMs }: Partial<Omit<ScriptedGrant, 'nodeId'>> = {},
  ): this {
    this.grants.push({ nodeId, floorMs, prevUntilMs, dbNowMs });
    return this;
  }

  exhausted(): this {
    this.grants.push(null);
    return this;
  }

  acquire(request: AcquireRequest): Promise<LeaseGrant | null> {
    if (this.grants.length === 0) throw new Error('no grant scripted');
    const grant = this.grants.shift() ?? null;
    if (grant === null) return Promise.resolve(null);
    const dbNowMs = grant.dbNowMs ?? this.nowMs();
    return Promise.resolve({
      ...grant,
      generation: ++this.generation,
      leaseUntilMs: dbNowMs + request.ttlMs,
      dbNowMs,
    });
  }

  renew(request: RenewRequest): Promise<number | null> {
    this.renewals.push(request);
    if (this.renewResult instanceof Error) return Promise.reject(this.renewResult);
    return Promise.resolve(this.renewResult ? this.nowMs() + request.ttlMs : null);
  }

  release(request: ReleaseRequest): Promise<void> {
    this.releases.push(request);
    return Promise.resolve();
  }
}

function leaseWith(store: LeaseStore, fake: FakeClock, overrides: Partial<NodeLeaseOptions> = {}): NodeLease {
  return NodeLease.createWithClock({
    store,
    holder: HOLDER,
    ttlMs: TTL_MS,
    quarantineMs: QUARANTINE_MS,
    fenceMarginMs: FENCE_MARGIN_MS,
    clock: fake.clock,
    ...overrides,
  });
}

async function heldLease(nodeId = 7): Promise<{ lease: NodeLease; store: FakeLeaseStore; fake: FakeClock }> {
  const fake = fakeClock();
  const store = new FakeLeaseStore(fake.realMs).grant(nodeId);
  const lease = leaseWith(store, fake);
  await lease.acquire();
  return { lease, store, fake };
}

function expectRefused(lease: NodeLease, state: string): void {
  expect(() => lease.generate(BUCKET)).toThrow(LeaseNotHeldError);
  expect(lease.state).toBe(state);
}

describe('NodeLease', () => {
  it('refuses to mint before a node is held', () => {
    expectRefused(leaseWith(new FakeLeaseStore(), fakeClock()), 'idle');
  });

  it('mints ids stamped with the node it was granted', async () => {
    const store = new FakeLeaseStore().grant(7);
    const lease = leaseWith(store, fakeClock());

    await expect(lease.acquire()).resolves.toMatchObject({ kind: 'held', nodeId: 7 });

    expect(lease.state).toBe('held');
    expect(lease.nodeId).toBe(7);
    expect(decode(lease.generate(BUCKET))).toMatchObject({ nodeId: 7, bucket: BUCKET });
  });

  it('keeps minting across a successful renew, past where the first grant would have fenced', async () => {
    const { lease, store, fake } = await heldLease();
    fake.advance(TTL_MS - FENCE_MARGIN_MS - 1);

    await expect(lease.renew()).resolves.toBe('renewed');
    fake.advance(TTL_MS - FENCE_MARGIN_MS - 1);

    expect(() => lease.generate(BUCKET)).not.toThrow();
    expect(store.renewals).toHaveLength(1);
  });

  it('reports the last minted timestamp on renew, so the next holder starts above it', async () => {
    const { lease, store, fake } = await heldLease();
    fake.advance(1_000);
    const { tsMs } = decode(lease.generate(BUCKET));

    await lease.renew();

    expect(store.renewals[0]).toMatchObject({ nodeId: 7, holder: HOLDER, generation: 1, ttlMs: TTL_MS, lastMs: tsMs });
  });

  // A lost database is not a lost lease: the row is still ours until it expires, so the replica
  // keeps serving on the time it has left and stops short of the expiry by the margin.
  it('keeps minting through failed renewals until the fence deadline, then refuses', async () => {
    const { lease, store, fake } = await heldLease();
    store.renewResult = new Error('connection refused');

    fake.advance(TTL_MS - FENCE_MARGIN_MS - 1);
    await expect(lease.renew()).rejects.toThrow('connection refused');
    expect(() => lease.generate(BUCKET)).not.toThrow();

    fake.advance(1);
    expectRefused(lease, 'fenced');
  });

  it('stops minting the moment a renew finds the lease gone', async () => {
    const { lease, store } = await heldLease();
    store.renewResult = false;

    await expect(lease.renew()).resolves.toBe('lost');

    expectRefused(lease, 'lost');
    expect(lease.nodeId).toBeUndefined();
  });

  it('acquires a fresh node after losing one, starting above everything it already minted', async () => {
    const { lease, store, fake } = await heldLease(7);
    fake.advance(5);
    const before = decode(lease.generate(BUCKET));
    store.renewResult = false;
    await lease.renew();

    // The fresh node's floor is older than what this process already minted, and its clock regressed.
    store.grant(9, { floorMs: before.tsMs - 1_000 });
    fake.stepWallBy(-2_000);
    await expect(lease.acquire()).resolves.toMatchObject({ kind: 'held', nodeId: 9 });

    const after = decode(lease.generate(BUCKET));
    expect(after.nodeId).toBe(9);
    expect(after.tsMs).toBeGreaterThan(before.tsMs);
  });

  it("starts a new holder above the previous holder's last timestamp", async () => {
    const floorMs = START_MS + 5_000;
    const store = new FakeLeaseStore().grant(3, { floorMs });
    const lease = leaseWith(store, fakeClock());

    await lease.acquire();

    expect(decode(lease.generate(BUCKET)).tsMs).toBeGreaterThan(floorMs);
  });

  // A holder that died between renewals never reported its last ids, and its clock may have run ahead
  // of this one. Neither matters: it never stamped past its lease end, and this holder starts above it.
  it("starts a new holder above where the previous holder's lease ended", async () => {
    const prevUntilMs = START_MS + 20_000;
    const store = new FakeLeaseStore().grant(3, {
      floorMs: START_MS - 60_000,
      prevUntilMs,
      dbNowMs: prevUntilMs + QUARANTINE_MS,
    });
    const lease = leaseWith(store, fakeClock());

    await lease.acquire();

    expect(decode(lease.generate(BUCKET)).tsMs).toBeGreaterThan(prevUntilMs);
  });

  it('refuses an id stamped past its lease end, until a renew moves the end on', async () => {
    const fake = fakeClock();
    // This replica's clock runs 250s ahead of the database's, so the lease ends long before its fence.
    const store = new FakeLeaseStore(() => fake.realMs() - 250_000).grant(7);
    const lease = leaseWith(store, fake);
    await lease.acquire();
    expect(() => lease.generate(BUCKET)).not.toThrow();

    fake.advance(TTL_MS - 250_000 + 1);
    expectRefused(lease, 'fenced');

    await expect(lease.renew()).resolves.toBe('renewed');
    expect(() => lease.generate(BUCKET)).not.toThrow();
  });

  // A freeze (SIGSTOP, a paused VM) landing between the fence check and the generator's clock read.
  it('refuses an id when the process froze between checking the fence and stamping it', async () => {
    const { lease, fake } = await heldLease();

    fake.pauseAfter(2, TTL_MS + QUARANTINE_MS);

    expectRefused(lease, 'fenced');
  });

  // A previous holder whose clock ran far ahead left a floor that would drag every id this replica
  // mints into the future. The node is handed back instead, and the caller retries.
  it('hands back a node whose floor sits too far ahead of the database clock', async () => {
    const aheadMs = FENCE_MARGIN_MS + 1;
    const store = new FakeLeaseStore().grant(3, { floorMs: START_MS + aheadMs });
    const lease = leaseWith(store, fakeClock());

    await expect(lease.acquire()).resolves.toEqual({ kind: 'floor_rejected', nodeId: 3, aheadMs });

    expect(store.releases).toEqual([{ nodeId: 3, holder: HOLDER, generation: 1, lastMs: null }]);
    expectRefused(lease, 'acquiring');
  });

  it('accepts a floor ahead of the database clock by no more than the configured bound', async () => {
    const store = new FakeLeaseStore().grant(3, { floorMs: START_MS + 60_000 });
    const lease = leaseWith(store, fakeClock(), { maxFloorAheadMs: 60_000 });

    await expect(lease.acquire()).resolves.toMatchObject({ kind: 'held', nodeId: 3 });
  });

  it('reports an exhausted pool and keeps refusing', async () => {
    const lease = leaseWith(new FakeLeaseStore().exhausted(), fakeClock());

    await expect(lease.acquire()).resolves.toEqual({ kind: 'exhausted' });

    expectRefused(lease, 'exhausted');
  });

  // The monotonic clock stops while a host is suspended, so it alone would wake up believing no time
  // had passed and mint on a node the database handed to someone else in the meantime.
  it('fences on the wall clock when a suspend outlasts the lease', async () => {
    const { lease, fake } = await heldLease();

    fake.stepWallBy(TTL_MS + QUARANTINE_MS);

    expectRefused(lease, 'fenced');
  });

  it('fences on a wall-clock jump larger than the margin, until a renew succeeds', async () => {
    const { lease, fake } = await heldLease();
    fake.advance(1_000);

    fake.stepWallBy(FENCE_MARGIN_MS + 1);
    expectRefused(lease, 'fenced');

    await expect(lease.renew()).resolves.toBe('renewed');
    expect(() => lease.generate(BUCKET)).not.toThrow();
  });

  it('keeps minting while draining, then releases with the last timestamp and stops', async () => {
    const { lease, store, fake } = await heldLease();

    lease.drain();
    expect(lease.state).toBe('draining');
    fake.advance(2);
    const { tsMs } = decode(lease.generate(BUCKET));

    await lease.release();

    expect(store.releases).toEqual([{ nodeId: 7, holder: HOLDER, generation: 1, lastMs: tsMs }]);
    expectRefused(lease, 'released');
  });

  it('refuses to acquire once draining has begun', async () => {
    const lease = leaseWith(new FakeLeaseStore().grant(7), fakeClock());
    lease.drain();

    await expect(lease.acquire()).rejects.toThrow(/draining/);
  });

  it('releases with no floor when nothing was minted, leaving the recorded one alone', async () => {
    const { lease, store } = await heldLease();

    await lease.release();

    expect(store.releases).toEqual([{ nodeId: 7, holder: HOLDER, generation: 1, lastMs: null }]);
  });

  it('refuses a second acquire while a node is held', async () => {
    const { lease } = await heldLease();

    await expect(lease.acquire()).rejects.toThrow(/held/);
  });

  // Two acquires in flight would each claim a node, and the one overwritten would sit leased to
  // nobody until it expired.
  it('refuses to start a store operation while another is in flight', async () => {
    const store = new FakeLeaseStore().grant(7).grant(8);
    const lease = leaseWith(store, fakeClock());

    const first = lease.acquire();
    await expect(lease.acquire()).rejects.toThrow(/overlap/);
    await expect(first).resolves.toMatchObject({ nodeId: 7 });
  });

  it('mints on the system clock outside tests', async () => {
    const lease = NodeLease.create({
      store: new FakeLeaseStore(Date.now).grant(5),
      holder: HOLDER,
      ttlMs: TTL_MS,
      quarantineMs: QUARANTINE_MS,
      fenceMarginMs: FENCE_MARGIN_MS,
    });

    await lease.acquire();

    expect(Math.abs(decode(lease.generate(BUCKET)).tsMs - Date.now())).toBeLessThan(1_000);
  });

  it('releases without touching the store when nothing is held', async () => {
    const store = new FakeLeaseStore();
    const lease = leaseWith(store, fakeClock());

    await lease.release();

    expect(store.releases).toEqual([]);
    expect(lease.state).toBe('released');
  });

  it('refuses to renew a lease it does not hold', async () => {
    await expect(leaseWith(new FakeLeaseStore(), fakeClock()).renew()).rejects.toThrow(/idle/);
  });

  it('exposes the generator it mints with, and drops it once the node is gone', async () => {
    const { lease, store } = await heldLease();
    expect(lease.generator?.nodeId).toBe(7);

    store.renewResult = false;
    await lease.renew();

    expect(lease.generator).toBeNull();
  });

  it('rejects options that leave no window to mint in', () => {
    const store = new FakeLeaseStore();
    const invalid: Partial<NodeLeaseOptions>[] = [
      { holder: '' },
      { ttlMs: 0 },
      { fenceMarginMs: 0 },
      { fenceMarginMs: TTL_MS },
      { quarantineMs: -1 },
      { maxFloorAheadMs: -1 },
    ];
    for (const overrides of invalid) {
      expect(() => leaseWith(store, fakeClock(), overrides)).toThrow(RangeError);
    }
  });
});
