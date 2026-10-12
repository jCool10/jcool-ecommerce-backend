import {
  castGrpcError,
  type Etcd3,
  EtcdLeaseInvalidError,
  type ICompare,
  type ILeaseKeepAliveResponse,
  type IRequestOp,
  type ITxnResponse,
} from 'etcd3';
import type { LeaseGrant, LeaseStore } from '@jcool/id-generator';
import type { EtcdConfig } from '../config/configuration';
import {
  decodeOwner,
  encodeMs,
  encodeOwner,
  floorOf,
  type HeldEntry,
  isHeldBy,
  LeaseKeyspace,
  type NodeEntry,
} from './etcd-lease-keyspace';

export class LeaseKeyspaceUninitializedError extends Error {
  constructor(prefix: string) {
    super(`etcd keyspace ${prefix} has no floors recorded; run the floor lift before any replica mints`);
    this.name = 'LeaseKeyspaceUninitializedError';
  }
}

/**
 * etcd keeps no clock a client can read, so a lease end here is a ceiling in the id timestamp domain:
 * a claim or a renew raises the node's floor key to the highest timestamp this holder may stamp, and
 * the next claim floors its generator above it. The etcd lease decides only when a node may change
 * hands; the ids stay unique whatever the replicas' clocks or timings do.
 */
export class EtcdLeaseStore implements LeaseStore {
  private readonly keys: LeaseKeyspace;
  // Kept until a claim under it is confirmed: an acquire retried after an unknown outcome then finds
  // its own owner key by lease id instead of claiming a second node.
  private pendingLeaseId: string | null = null;

  constructor(
    private readonly etcd: Etcd3,
    private readonly options: Pick<EtcdConfig, 'keyPrefix' | 'requestTimeoutMs'>,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.keys = new LeaseKeyspace(options.keyPrefix);
  }

  async acquire({ holder, ttlMs }: Parameters<LeaseStore['acquire']>[0]): Promise<LeaseGrant | null> {
    try {
      return await this.acquireUnderLease(holder, ttlMs);
    } catch (err) {
      if (err instanceof EtcdLeaseInvalidError) this.pendingLeaseId = null;
      throw err;
    }
  }

  async renew(request: Parameters<LeaseStore['renew']>[0]): Promise<number | null> {
    const nowMs = this.nowMs();
    const entry = await this.readNode(request.nodeId);
    if (!isHeldBy(entry, request.generation)) return null;
    if (!(await this.keepAlive(entry.owner.lease))) return null;
    return this.raiseCeiling(entry, request.generation, Math.max(nowMs, request.lastMs), request.ttlMs);
  }

  async release(request: Parameters<LeaseStore['release']>[0]): Promise<void> {
    const entry = await this.readNode(request.nodeId);
    if (!isHeldBy(entry, request.generation)) return;
    // Minting has stopped for good, so the floor can come down from the reserved ceiling to what was
    // really stamped; the next holder then starts near the present instead of a TTL ahead of it.
    const floorMs = Math.max(decodeOwner(entry.owner).claimFloorMs ?? 0, request.lastMs ?? 0);
    await this.txn(
      [this.heldBy(request.nodeId, request.generation)],
      [
        { request_put: { key: this.keys.floor(request.nodeId), value: encodeMs(floorMs) } },
        { request_delete_range: { key: this.keys.owner(request.nodeId) } },
      ],
    );
    await this.revokeQuietly(entry.owner.lease);
  }

  private async acquireUnderLease(holder: string, ttlMs: number): Promise<LeaseGrant | null> {
    const leaseId = await this.leaseForClaim(ttlMs);
    const snapshot = this.keys.snapshot((await this.etcd.kv.range(this.keys.all(), this.callOptions())).kvs);
    if (!snapshot.initialized) throw new LeaseKeyspaceUninitializedError(this.keys.prefix);

    const own = snapshot.ownedBy(leaseId);
    if (own !== undefined) return this.confirm(await this.readopt(own, ttlMs));

    const free = snapshot.freeOldestFirst();
    let next = 0;
    while (free.length > 0) {
      const [candidate] = free.splice(next, 1);
      const grant = await this.claim(candidate, holder, leaseId, ttlMs);
      if (grant !== null) return this.confirm(grant);
      // Every claimant races for the same oldest node; one that lost once spreads out.
      next = Math.floor(Math.random() * free.length);
    }

    this.pendingLeaseId = null;
    await this.revokeQuietly(leaseId);
    return null;
  }

  private async leaseForClaim(ttlMs: number): Promise<string> {
    if (this.pendingLeaseId !== null && (await this.keepAlive(this.pendingLeaseId))) return this.pendingLeaseId;
    const { ID } = await this.etcd.leaseClient.leaseGrant({ TTL: Math.ceil(ttlMs / 1_000) }, this.callOptions());
    this.pendingLeaseId = ID;
    return ID;
  }

  private async claim(entry: NodeEntry, holder: string, leaseId: string, ttlMs: number): Promise<LeaseGrant | null> {
    const { nodeId } = entry;
    const floorMs = floorOf(entry);
    const nowMs = this.nowMs();
    const ceilingMs = Math.max(nowMs, floorMs ?? 0) + ttlMs;
    // The floor must still be the one read, or the claim would record a floor it never saw.
    const { succeeded, header } = await this.txn(
      [
        { key: this.keys.owner(nodeId), target: 'Create', result: 'Equal', create_revision: 0 },
        { key: this.keys.floor(nodeId), target: 'Mod', result: 'Equal', mod_revision: entry.floor?.mod_revision ?? 0 },
      ],
      [
        {
          request_put: {
            key: this.keys.owner(nodeId),
            value: encodeOwner({ holder, claimFloorMs: floorMs }),
            lease: leaseId,
          },
        },
        { request_put: { key: this.keys.floor(nodeId), value: encodeMs(ceilingMs) } },
      ],
    );
    return succeeded ? { nodeId, generation: Number(header.revision), floorMs, leaseUntilMs: ceilingMs, nowMs } : null;
  }

  // The claim's ceiling dates from its first attempt, which may be long past; raised as a renew would.
  private async readopt(entry: HeldEntry, ttlMs: number): Promise<LeaseGrant> {
    const generation = Number(entry.owner.create_revision);
    const nowMs = this.nowMs();
    const ceilingMs = await this.raiseCeiling(entry, generation, nowMs, ttlMs);
    if (ceilingMs === null) throw new Error(`node ${entry.nodeId} changed hands while being re-adopted`);
    return {
      nodeId: entry.nodeId,
      generation,
      floorMs: decodeOwner(entry.owner).claimFloorMs,
      leaseUntilMs: ceilingMs,
      nowMs,
    };
  }

  // Never lowered within a tenure: a wall clock stepping back must not take back a ceiling already used.
  private async raiseCeiling(
    entry: NodeEntry,
    generation: number,
    stampedMs: number,
    ttlMs: number,
  ): Promise<number | null> {
    const ceilingMs = Math.max(floorOf(entry) ?? 0, stampedMs + ttlMs);
    const { succeeded } = await this.txn(
      [this.heldBy(entry.nodeId, generation)],
      [{ request_put: { key: this.keys.floor(entry.nodeId), value: encodeMs(ceilingMs) } }],
    );
    return succeeded ? ceilingMs : null;
  }

  private confirm(grant: LeaseGrant): LeaseGrant {
    this.pendingLeaseId = null;
    return grant;
  }

  private async readNode(nodeId: number): Promise<NodeEntry> {
    const { kvs } = await this.etcd.kv.range(this.keys.node(nodeId), this.callOptions());
    return this.keys.snapshot(kvs).entry(nodeId);
  }

  private heldBy(nodeId: number, generation: number): ICompare {
    return { key: this.keys.owner(nodeId), target: 'Create', result: 'Equal', create_revision: generation };
  }

  private txn(compare: ICompare[], success: IRequestOp[]): Promise<ITxnResponse> {
    return this.etcd.kv.txn({ compare, success }, this.callOptions());
  }

  /** False once etcd reports the lease expired or revoked. */
  private async keepAlive(leaseId: string): Promise<boolean> {
    const stream = await this.etcd.leaseClient.leaseKeepAlive(this.callOptions());
    try {
      const answer = await new Promise<ILeaseKeepAliveResponse>((resolve, reject) => {
        stream.on('data', resolve);
        stream.on('error', (err) => reject(castGrpcError(err)));
        stream.on('end', () => reject(new Error('lease keepalive stream ended without an answer')));
        stream.write({ ID: leaseId });
      });
      return answer.TTL !== '0';
    } finally {
      stream.end();
    }
  }

  // Cleanup only: a lease left behind holds no key and runs out on its own.
  private async revokeQuietly(leaseId: string): Promise<void> {
    await this.etcd.leaseClient.leaseRevoke({ ID: leaseId }, this.callOptions()).catch(() => undefined);
  }

  private callOptions(): { deadline: number } {
    return { deadline: Date.now() + this.options.requestTimeoutMs };
  }
}
