import { NODE_ID_MAX } from '../node-ids';
import { UnknownServicePoolError } from './lease.errors';

const MAX_POOL_SIZE = NODE_ID_MAX + 1;

/**
 * `ID_SERVICE_POOLS` is an allowlist in config rather than a registry table: one variable beats a
 * second table plus its CRUD, and an unknown service name has to fail *before* a query, because the
 * acquire statement seeds a pool on first contact — a typo would otherwise mint its own silently.
 */
export type ServicePools = ReadonlyMap<string, number>;

const ENTRY = /^([a-z][a-z0-9-]*):(\d+)$/;

export function parseServicePools(raw: string): ServicePools {
  const pools = new Map<string, number>();

  for (const entry of raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = ENTRY.exec(entry);
    if (!match) {
      throw new Error(`ID_SERVICE_POOLS entry "${entry}" is not "name:size" (lowercase name, positive size)`);
    }
    const [, name, size] = match;
    const poolSize = Number(size);
    if (poolSize < 1 || poolSize > MAX_POOL_SIZE) {
      throw new Error(`ID_SERVICE_POOLS pool "${name}" must be between 1 and ${MAX_POOL_SIZE} nodes, got ${poolSize}`);
    }
    if (pools.has(name)) {
      throw new Error(`ID_SERVICE_POOLS declares "${name}" twice`);
    }
    pools.set(name, poolSize);
  }

  if (pools.size === 0) {
    throw new Error('ID_SERVICE_POOLS declares no pools');
  }

  return pools;
}

export function poolSizeFor(pools: ServicePools, service: string): number {
  const size = pools.get(service);
  if (size === undefined) {
    throw new UnknownServicePoolError(service, [...pools.keys()]);
  }
  return size;
}
