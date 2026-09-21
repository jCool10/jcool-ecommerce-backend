import { execFileSync } from 'node:child_process';
import type { StartedTestContainer } from 'testcontainers';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { MAX_IDS_PER_REQUEST } from '../../src/mint/mint.request';
import { sleep } from '../setup/eventually';
import {
  buildImages,
  collisions,
  type MintRun,
  mintTimes,
  mintUntil,
  readiness,
  SHUTDOWN_GRACE_MS,
  type Stack,
  startReplicas,
  startStack,
  stopStack,
} from './replica-set';

// Past the gateway's DNS refresh, so it has seen whatever the step changed.
const DNS_SETTLE_MS = 6_000;

// A request buys one node-millisecond, so the load arrives as many small batches rather than a few
// large ones; the total is what the collision check needs.
const TOTAL_IDS = 100_000;

beforeAll(buildImages);

describe('id-service replicas behind the gateway', () => {
  let stack: Stack | undefined;

  beforeEach(async () => {
    stack = await startStack();
  });

  afterEach(() => stopStack(stack));

  it('mints 100k ids across three replicas with no id or (ts, node, seq) repeated', async () => {
    const run = await mintTimes(stack!.lbUrl, TOTAL_IDS / MAX_IDS_PER_REQUEST, 10, MAX_IDS_PER_REQUEST);

    expect(run.failures).toEqual([]);
    expect(run.ids).toHaveLength(TOTAL_IDS);
    const { duplicateIds, duplicateTriples, nodes } = collisions(run.ids);
    expect({ duplicateIds, duplicateTriples }).toEqual({ duplicateIds: 0, duplicateTriples: 0 });
    expect(nodes.size).toBe(3);
  });

  it('keeps every caller served while a replica is killed mid-load', async () => {
    const [killed] = stack!.replicas;
    const run = await mintUntil(
      stack!.lbUrl,
      (async () => {
        await sleep(1_000);
        await killed.stop({ timeout: 0 });
        await sleep(3_000);
      })(),
    );

    expect(run.failures).toEqual([]);
    expect(collisions(run.ids).duplicateTriples).toBe(0);
  });

  it('routes around a frozen replica within the try deadline', async () => {
    const [frozen] = stack!.replicas;
    const run = await mintUntil(
      stack!.lbUrl,
      (async () => {
        await sleep(500);
        execFileSync('docker', ['kill', '--signal=SIGSTOP', frozen.getId()]);
        try {
          await sleep(3_000);
        } finally {
          execFileSync('docker', ['kill', '--signal=SIGCONT', frozen.getId()]);
        }
      })(),
    );

    expect(run.failures).toEqual([]);
    expect(run.maxLatencyMs).toBeLessThan(1_000);
  });

  // Start-first, as Railway rolls a deployment: new replicas come up, then the old ones drain and exit.
  it('keeps every caller served while all three replicas are replaced', async () => {
    const run = await mintUntil(
      stack!.lbUrl,
      (async () => {
        const old = stack!.replicas;
        const fresh = await startReplicas(stack!.network, 3);
        stack!.replicas = [...old, ...fresh];
        await sleep(DNS_SETTLE_MS);
        await Promise.all(old.map((replica) => replica.stop({ timeout: SHUTDOWN_GRACE_MS * 3 })));
        stack!.replicas = fresh;
        await sleep(DNS_SETTLE_MS);
      })(),
    );

    expect(run.failures).toEqual([]);
    const { duplicateIds, duplicateTriples, nodes } = collisions(run.ids);
    expect({ duplicateIds, duplicateTriples }).toEqual({ duplicateIds: 0, duplicateTriples: 0 });
    expect(nodes.size).toBe(6);
  });
});

// Short enough that a node changes hands within the test; the pool is cut to the three replicas' nodes.
const SHORT_LEASE = {
  ID_LEASE_TTL_MS: '6000',
  ID_LEASE_RENEW_EVERY_MS: '1000',
  ID_LEASE_FENCE_MARGIN_MS: '2000',
  ID_LEASE_QUARANTINE_MS: '1000',
};

function timestampsOn(nodeId: number, run: MintRun): number[] {
  return run.ids.map((id) => decode(id)).flatMap((id) => (id.nodeId === nodeId ? [id.tsMs] : []));
}

describe('a node changing hands under load', () => {
  let stack: Stack | undefined;

  beforeEach(async () => {
    stack = await startStack(3, { env: SHORT_LEASE, freeNodes: 3 });
  });

  afterEach(() => stopStack(stack));

  // Frozen (SIGSTOP, a paused VM) past its lease, a holder loses its node to a new replica, and on
  // waking refuses to mint rather than share it.
  it("passes a frozen replica's node on once its lease ran out, above every id it minted", async () => {
    const [frozen] = stack!.replicas;
    const { nodeId } = await readiness(frozen);
    if (nodeId === undefined) throw new Error('replica holds no node');

    const before = await mintUntil(stack!.lbUrl, sleep(1_500));
    execFileSync('docker', ['kill', '--signal=SIGSTOP', frozen.getId()]);
    let successor: StartedTestContainer | undefined;
    const after = await mintUntil(
      stack!.lbUrl,
      (async () => {
        try {
          [successor] = await startReplicas(stack!.network, 1, SHORT_LEASE);
          stack!.replicas.push(successor);
          await sleep(DNS_SETTLE_MS);
        } finally {
          execFileSync('docker', ['kill', '--signal=SIGCONT', frozen.getId()]);
        }
        await sleep(3_000);
      })(),
    );

    expect([...before.failures, ...after.failures]).toEqual([]);
    expect((await readiness(successor!)).nodeId).toBe(nodeId);
    expect((await readiness(frozen)).status).toBe(503);

    const minted = timestampsOn(nodeId, before);
    const handedOn = timestampsOn(nodeId, after);
    expect(minted.length).toBeGreaterThan(0);
    expect(handedOn.length).toBeGreaterThan(0);
    expect(handedOn.reduce((a, b) => Math.min(a, b))).toBeGreaterThan(minted.reduce((a, b) => Math.max(a, b)));
    const { duplicateIds, duplicateTriples } = collisions([...before.ids, ...after.ids]);
    expect({ duplicateIds, duplicateTriples }).toEqual({ duplicateIds: 0, duplicateTriples: 0 });
  });
});
