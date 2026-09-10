import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { LeaseHolder, type MintSource } from './lease-holder';
import { NoNodeAvailableError } from './lease.errors';
import type { NodeIdLeasePort, NodeLease } from './node-id-lease.port';

const TTL_SECONDS = 30;
const SKEW_MS = 5_000;
// What the constructor derives from those two, restated so the timings below are readable:
const RENEW_INTERVAL_MS = 10_000; // ttl / 3
const DEADLINE_MS = 20_000; // ttl - max(skew, renewInterval), anchored at send
const GRACE_MS = 30_000; // 3 renewal intervals

const LEASE: NodeLease = { service: 'user', node: 7, leaseId: 'lease-a' };
const LAST_MS = 1_756_000_000_000;

interface FakePort extends NodeIdLeasePort {
  renewResult: boolean | 'throw' | 'hang';
  renewedWith: number[];
  releasedWith: Array<{ lease: NodeLease; lastMs: number }>;
}

function fakePort(acquired: NodeLease | null = LEASE): FakePort {
  const port: FakePort = {
    renewResult: true,
    renewedWith: [],
    releasedWith: [],
    acquire: () => Promise.resolve(acquired),
    renew: (_lease: NodeLease, lastMs: number) => {
      port.renewedWith.push(lastMs);
      if (port.renewResult === 'throw') return Promise.reject(new Error('connection terminated'));
      // Never settles: a renewal still in flight when the deadline elapses.
      if (port.renewResult === 'hang') return new Promise<boolean>(() => {});
      return Promise.resolve(port.renewResult);
    },
    release: (lease: NodeLease, lastMs: number) => {
      port.releasedWith.push({ lease, lastMs });
      return Promise.resolve();
    },
  };
  return port;
}

function fakeSource(): MintSource & { fenced: boolean } {
  const source = {
    lastMs: LAST_MS,
    fenced: false,
    fence: (): void => {
      source.fenced = true;
    },
  };
  return source;
}

describe('LeaseHolder', () => {
  let clockMs: number;
  let onLost: Mock<() => void>;
  let onGiveUp: Mock<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    clockMs = 0;
    onLost = vi.fn<() => void>();
    onGiveUp = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function holderFor(port: NodeIdLeasePort): LeaseHolder {
    return new LeaseHolder(port, {
      service: 'user',
      holder: 'test-holder',
      ttlSeconds: TTL_SECONDS,
      skewMs: SKEW_MS,
      onLost,
      onGiveUp,
      monotonicMs: () => clockMs,
    });
  }

  // Stepped rather than jumped: the deadline compares the injected clock against its own anchor, so
  // a single leap would fire the timer with the clock already far past where it fired.
  async function advance(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1_000) {
      const step = Math.min(1_000, left);
      clockMs += step;
      await vi.advanceTimersByTimeAsync(step);
    }
  }

  it('holds the acquired node', async () => {
    const holder = holderFor(fakePort());

    await expect(holder.start()).resolves.toBe(7);
    expect(holder.node).toBe(7);
    expect(holder.isValid).toBe(true);
  });

  // No degraded mode: a process with no node id has no id it may safely mint under.
  it('refuses to start when the pool is exhausted', async () => {
    const holder = holderFor(fakePort(null));

    await expect(holder.start()).rejects.toThrow(NoNodeAvailableError);
    expect(holder.isValid).toBe(false);
    expect(holder.node).toBeNull();
  });

  it('renews three times per TTL, reporting the highest millisecond minted', async () => {
    const port = fakePort();
    const holder = holderFor(port);
    await holder.start();
    holder.attach(fakeSource());

    await advance(TTL_SECONDS * 1_000 + RENEW_INTERVAL_MS / 2);

    expect(port.renewedWith).toEqual([LAST_MS, LAST_MS, LAST_MS]);
    expect(holder.isValid).toBe(true);
  });

  it('resets the age on each renewal', async () => {
    const holder = holderFor(fakePort());
    await holder.start();

    await advance(RENEW_INTERVAL_MS - 1_000);
    expect(holder.ageSeconds).toBeCloseTo(9, 3);

    await advance(2_000);
    expect(holder.ageSeconds).toBeCloseTo(1, 3);
  });

  describe('when the node is stolen', () => {
    it('fences the generator, reports the loss, then gives up after the grace window', async () => {
      const port = fakePort();
      port.renewResult = false;
      const holder = holderFor(port);
      const source = fakeSource();
      await holder.start();
      holder.attach(source);

      await advance(RENEW_INTERVAL_MS);

      expect(source.fenced).toBe(true);
      expect(holder.isValid).toBe(false);
      expect(holder.lostTotal).toBe(1);
      expect(onLost).toHaveBeenCalledTimes(1);
      // The grace window is for draining in-flight requests, not for the lease to come back.
      expect(onGiveUp).not.toHaveBeenCalled();

      await advance(GRACE_MS);
      expect(onGiveUp).toHaveBeenCalledTimes(1);
    });

    // The exit exists to get a fenced process replaced. A shutdown is already doing that, and
    // exiting through it would cut the drain short.
    it('drops the pending exit when the app shuts down first', async () => {
      const port = fakePort();
      port.renewResult = false;
      const holder = holderFor(port);
      await holder.start();
      await advance(RENEW_INTERVAL_MS);

      await holder.stop();
      await advance(GRACE_MS * 2);

      expect(onGiveUp).not.toHaveBeenCalled();
    });

    it('stops renewing and never releases a node it no longer holds', async () => {
      const port = fakePort();
      port.renewResult = false;
      const holder = holderFor(port);
      await holder.start();

      await advance(RENEW_INTERVAL_MS + TTL_SECONDS * 1_000);
      await holder.stop();

      expect(port.renewedWith).toHaveLength(1);
      expect(port.releasedWith).toHaveLength(0);
    });

    // A steal inside the boot window: the generator is built from the node id, so it can only be
    // attached after start(), and by then the lease may already be gone.
    it('fences a source attached after the loss', async () => {
      const port = fakePort();
      port.renewResult = false;
      const holder = holderFor(port);
      await holder.start();
      await advance(RENEW_INTERVAL_MS);

      const source = fakeSource();
      holder.attach(source);

      expect(source.fenced).toBe(true);
    });
  });

  describe('when renewals fail on transport', () => {
    // Fencing on a connection error would 503 the whole fleet on a Postgres blip. The lease is still
    // held; only the deadline decides otherwise.
    it('counts the failures and keeps trying inside the TTL', async () => {
      const port = fakePort();
      port.renewResult = 'throw';
      const holder = holderFor(port);
      const source = fakeSource();
      await holder.start();
      holder.attach(source);

      await advance(RENEW_INTERVAL_MS + 1_000);

      expect(holder.renewalFailureCount).toBe(1);
      expect(holder.isValid).toBe(true);
      expect(source.fenced).toBe(false);
    });

    it('fences once the send-anchored deadline passes', async () => {
      const port = fakePort();
      port.renewResult = 'throw';
      const holder = holderFor(port);
      const source = fakeSource();
      await holder.start();
      holder.attach(source);

      await advance(DEADLINE_MS - 1_000);
      expect(holder.isValid).toBe(true);
      expect(holder.renewalFailureCount).toBe(1);

      await advance(2_000);
      expect(holder.isValid).toBe(false);
      expect(source.fenced).toBe(true);
      // Nothing retried after the fence, including the renewal that was due at the same instant.
      expect(holder.renewalFailureCount).toBe(1);
    });

    // The reason the deadline runs on its own timer: a renewal that never returns would otherwise
    // leave nothing to notice the TTL elapsing.
    it('fences while a renewal is still in flight', async () => {
      const port = fakePort();
      port.renewResult = 'hang';
      const holder = holderFor(port);
      const source = fakeSource();
      await holder.start();
      holder.attach(source);

      await advance(DEADLINE_MS);

      expect(source.fenced).toBe(true);
      expect(onLost).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('releases the node with the highest millisecond minted under it', async () => {
      const port = fakePort();
      const holder = holderFor(port);
      await holder.start();
      holder.attach(fakeSource());

      await holder.stop();

      expect(port.releasedWith).toEqual([{ lease: LEASE, lastMs: LAST_MS }]);
      expect(holder.isValid).toBe(false);
    });

    // Nothing minted, so the reclaim guard has no high-water mark to respect.
    it('releases with zero when no generator was ever attached', async () => {
      const port = fakePort();
      const holder = holderFor(port);
      await holder.start();

      await holder.stop();

      expect(port.releasedWith).toEqual([{ lease: LEASE, lastMs: 0 }]);
    });

    it('stops renewing', async () => {
      const port = fakePort();
      const holder = holderFor(port);
      await holder.start();
      await holder.stop();

      await advance(TTL_SECONDS * 1_000);

      expect(port.renewedWith).toHaveLength(0);
    });
  });
});
