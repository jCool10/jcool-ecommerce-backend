import { randomUUID } from 'node:crypto';
import type { Etcd3, IKeyValue } from 'etcd3';
import { inject } from 'vitest';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';
import { createEtcdClient } from '../../src/etcd/etcd-client';
import { encodeMs, encodeOwner, LeaseKeyspace } from '../../src/lease/etcd-lease-keyspace';
import { EtcdLeaseStore } from '../../src/lease/etcd-lease-store';

export const ETCD_IMAGE = 'gcr.io/etcd-development/etcd:v3.6.5';
const REQUEST_TIMEOUT_MS = 2_000;
const PUTS_PER_TXN = 100;

declare module 'vitest' {
  interface ProvidedContext {
    ETCD_URL: string;
  }
}

/** A keyspace of the caller's own on the shared etcd, initialized but with no node ever leased. */
export async function freshKeyspace(url = inject('ETCD_URL')): Promise<string> {
  const prefix = `/e2e/${randomUUID()}/`;
  const etcd = createEtcdClient([url]);
  try {
    await etcd.kv.put({ key: new LeaseKeyspace(prefix).initialized, value: Buffer.from('{}') });
  } finally {
    etcd.close();
  }
  return prefix;
}

export class TestKeyspace {
  readonly keys: LeaseKeyspace;

  private constructor(
    readonly etcd: Etcd3,
    readonly prefix: string,
  ) {
    this.keys = new LeaseKeyspace(prefix);
  }

  static async open(prefix?: string, url = inject('ETCD_URL')): Promise<TestKeyspace> {
    return new TestKeyspace(createEtcdClient([url]), prefix ?? (await freshKeyspace(url)));
  }

  /** A store of its own, as a separate process would have, over the shared client. */
  store(): EtcdLeaseStore {
    return new EtcdLeaseStore(this.etcd, { keyPrefix: this.prefix, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  }

  async owner(nodeId: number): Promise<IKeyValue | undefined> {
    return (await this.etcd.kv.range({ key: this.keys.owner(nodeId) })).kvs[0];
  }

  async owners(): Promise<IKeyValue[]> {
    const { kvs } = await this.etcd.kv.range(this.keys.all());
    return kvs.filter((kv) => kv.key.toString().endsWith('/owner'));
  }

  async floor(nodeId: number): Promise<number | null> {
    const kv = (await this.etcd.kv.range({ key: this.keys.floor(nodeId) })).kvs[0];
    return kv === undefined ? null : Number(kv.value.toString());
  }

  async setFloor(nodeId: number, ms: number): Promise<void> {
    await this.etcd.kv.put({ key: this.keys.floor(nodeId), value: encodeMs(ms) });
  }

  /** What a lease running out leaves behind: the owner key gone, the floor as the holder last set it. */
  async expire(nodeId: number): Promise<void> {
    await this.etcd.kv.deleteRange({ key: this.keys.owner(nodeId) });
  }

  /** Takes every node but the listed ones, so a claim can only land where the spec expects. */
  async holdAllNodesExcept(...nodeIds: number[]): Promise<void> {
    const { ID } = await this.etcd.leaseClient.leaseGrant({ TTL: 3_600 });
    const held = [];
    for (let nodeId = LEASED_NODE_MIN; nodeId <= LEASED_NODE_MAX; nodeId++) {
      if (!nodeIds.includes(nodeId)) held.push(nodeId);
    }
    for (let i = 0; i < held.length; i += PUTS_PER_TXN) {
      await this.etcd.kv.txn({
        success: held.slice(i, i + PUTS_PER_TXN).map((nodeId) => ({
          request_put: {
            key: this.keys.owner(nodeId),
            value: encodeOwner({ holder: 'elsewhere', claimFloorMs: null }),
            lease: ID,
          },
        })),
      });
    }
  }

  close(): void {
    this.etcd.close();
  }
}
