import type { Etcd3, ICompare, IRequestOp } from 'etcd3';
import { encodeMs, floorOf, LeaseKeyspace } from './etcd-lease-keyspace';

// etcd refuses a txn with more than 128 compares or ops by default; two compares per node.
const NODES_PER_TXN = 50;

export type LiftOutcome = { kind: 'lifted'; floorMs: number } | { kind: 'already_initialized' };

/** Thrown while a replica of the lost keyspace may still be minting on a node the lift would reissue. */
export class LiftSettlingError extends Error {
  constructor(readonly remainingMs: number) {
    super(`keyspace seen empty; run again in ${Math.ceil(remainingMs / 1000)}s, once old replicas can no longer mint`);
  }
}

/**
 * Raises every node's floor to `nowMs` and marks the keyspace initialized. The caller guarantees no id
 * on this keyspace's nodes was stamped above `nowMs`: every replica stopped, and its TTL waited out.
 * Refuses while any node is held, since a holder's ceiling may sit past `nowMs`.
 * With `settleMs` the wait is enforced rather than assumed: the first run records when it found the keyspace
 * empty and every run refuses until `settleMs` (the lease TTL, which bounds any old ceiling) has passed since.
 */
export async function liftFloors(
  etcd: Etcd3,
  options: {
    keyPrefix: string;
    requestTimeoutMs: number;
    nowMs: number;
    onlyIfUninitialized: boolean;
    settleMs?: number;
  },
): Promise<LiftOutcome> {
  const keys = new LeaseKeyspace(options.keyPrefix);
  const call = () => ({ deadline: Date.now() + options.requestTimeoutMs });
  const snapshot = keys.snapshot((await etcd.kv.range(keys.all(), call())).kvs);
  if (snapshot.initialized && options.onlyIfUninitialized) return { kind: 'already_initialized' };

  const entries = snapshot.entries();
  const held = entries.filter((entry) => entry.owner !== undefined).map((entry) => entry.nodeId);
  if (held.length > 0) {
    throw new Error(`nodes still held (${held.join(', ')}): stop every replica and wait out its TTL first`);
  }

  if (options.settleMs !== undefined && options.settleMs > 0) {
    await requireSettled(etcd, keys, options.nowMs, options.settleMs, call);
  }

  for (let i = 0; i < entries.length; i += NODES_PER_TXN) {
    const chunk = entries.slice(i, i + NODES_PER_TXN);
    const compare: ICompare[] = chunk.flatMap((entry) => [
      { key: keys.owner(entry.nodeId), target: 'Create', result: 'Equal', create_revision: 0 },
      { key: keys.floor(entry.nodeId), target: 'Mod', result: 'Equal', mod_revision: entry.floor?.mod_revision ?? 0 },
    ]);
    const success: IRequestOp[] = chunk.map((entry) => ({
      request_put: { key: keys.floor(entry.nodeId), value: encodeMs(Math.max(floorOf(entry) ?? 0, options.nowMs)) },
    }));
    const { succeeded } = await etcd.kv.txn({ compare, success }, call());
    if (!succeeded) throw new Error('a node was claimed or released during the lift: stop every replica first');
  }

  const marker = Buffer.from(JSON.stringify({ liftedAtMs: options.nowMs }));
  await etcd.kv.txn(
    {
      compare: [],
      success: [
        { request_put: { key: keys.initialized, value: marker } },
        { request_delete_range: { key: keys.emptySince } },
      ],
    },
    call(),
  );
  return { kind: 'lifted', floorMs: options.nowMs };
}

async function requireSettled(
  etcd: Etcd3,
  keys: LeaseKeyspace,
  nowMs: number,
  settleMs: number,
  call: () => { deadline: number },
): Promise<void> {
  const recorded = (await etcd.kv.range({ key: keys.emptySince }, call())).kvs[0];
  if (recorded === undefined) {
    // A concurrent first run that wins the create recorded an equal or earlier instant; either is safe.
    await etcd.kv.txn(
      {
        compare: [{ key: keys.emptySince, target: 'Create', result: 'Equal', create_revision: 0 }],
        success: [{ request_put: { key: keys.emptySince, value: encodeMs(nowMs) } }],
      },
      call(),
    );
    throw new LiftSettlingError(settleMs);
  }
  const remainingMs = Number(recorded.value.toString()) + settleMs - nowMs;
  if (remainingMs > 0) throw new LiftSettlingError(remainingMs);
}
