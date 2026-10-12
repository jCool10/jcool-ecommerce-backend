import type { IKeyValue, IRangeRequest } from 'etcd3';
import { LEASED_NODE_MAX, LEASED_NODE_MIN } from '@jcool/id-generator';

/** Written with the claim, so a re-adopt after an unknown outcome knows the floor it claimed above. */
export interface OwnerRecord {
  holder: string;
  claimFloorMs: number | null;
}

export interface NodeEntry {
  nodeId: number;
  /** Attached to the holder's etcd lease: present exactly while the node is held. */
  owner?: IKeyValue;
  /** No lease: the highest timestamp any holder of the node may have stamped. */
  floor?: IKeyValue;
}

export type HeldEntry = NodeEntry & { owner: IKeyValue };

/** The owner key's create revision is the generation: no other incarnation of the key can share it. */
export function isHeldBy(entry: NodeEntry, generation: number): entry is HeldEntry {
  return entry.owner !== undefined && Number(entry.owner.create_revision) === generation;
}

const NODE_KEY = /^nodes\/(\d{3})\/(owner|floor)$/;

function rangeOver(prefix: Buffer): IRangeRequest {
  const rangeEnd = Buffer.from(prefix);
  rangeEnd[rangeEnd.length - 1] += 1;
  return { key: prefix, range_end: rangeEnd };
}

export function encodeMs(ms: number): Buffer {
  return Buffer.from(String(ms));
}

export function floorOf(entry: NodeEntry): number | null {
  return entry.floor === undefined ? null : Number(entry.floor.value.toString());
}

export function encodeOwner(record: OwnerRecord): Buffer {
  return Buffer.from(JSON.stringify(record));
}

export function decodeOwner(kv: IKeyValue): OwnerRecord {
  return JSON.parse(kv.value.toString()) as OwnerRecord;
}

export class LeaseKeyspace {
  constructor(readonly prefix: string) {}

  owner(nodeId: number): Buffer {
    return this.key(`${this.nodePath(nodeId)}owner`);
  }

  floor(nodeId: number): Buffer {
    return this.key(`${this.nodePath(nodeId)}floor`);
  }

  /** Set by the floor lift; a keyspace without it was never given floors and is not trusted. */
  get initialized(): Buffer {
    return this.key('initialized');
  }

  node(nodeId: number): IRangeRequest {
    return rangeOver(this.key(this.nodePath(nodeId)));
  }

  all(): IRangeRequest {
    return rangeOver(this.key(''));
  }

  snapshot(kvs: IKeyValue[]): KeyspaceSnapshot {
    const nodes = new Map<number, NodeEntry>();
    for (let nodeId = LEASED_NODE_MIN; nodeId <= LEASED_NODE_MAX; nodeId++) nodes.set(nodeId, { nodeId });
    let initialized = false;
    for (const kv of kvs) {
      const path = kv.key.toString().slice(this.prefix.length);
      if (path === 'initialized') initialized = true;
      const match = NODE_KEY.exec(path);
      if (match === null) continue;
      const entry = nodes.get(Number(match[1]));
      if (entry !== undefined) entry[match[2] as 'owner' | 'floor'] = kv;
    }
    return new KeyspaceSnapshot(initialized, nodes);
  }

  private nodePath(nodeId: number): string {
    return `nodes/${String(nodeId).padStart(3, '0')}/`;
  }

  private key(path: string): Buffer {
    return Buffer.from(this.prefix + path);
  }
}

export class KeyspaceSnapshot {
  constructor(
    readonly initialized: boolean,
    private readonly nodes: Map<number, NodeEntry>,
  ) {}

  entry(nodeId: number): NodeEntry {
    return this.nodes.get(nodeId) ?? { nodeId };
  }

  entries(): NodeEntry[] {
    return [...this.nodes.values()];
  }

  ownedBy(leaseId: string): HeldEntry | undefined {
    return this.entries().find((entry): entry is HeldEntry => entry.owner?.lease === leaseId);
  }

  /** The node whose floor was written longest ago first; never-leased nodes tie at 0, lowest id first. */
  freeOldestFirst(): NodeEntry[] {
    const writtenAt = (entry: NodeEntry) => Number(entry.floor?.mod_revision ?? 0);
    return this.entries()
      .filter((entry) => entry.owner === undefined)
      .sort((a, b) => writtenAt(a) - writtenAt(b) || a.nodeId - b.nodeId);
  }
}
