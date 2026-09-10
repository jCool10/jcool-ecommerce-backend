import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { DrizzleNodeIdLeaseRepository } from './drizzle-node-id-lease.repository';
import { UnknownServicePoolError } from './lease.errors';
import type { NodeLease } from './node-id-lease.port';
import { parseServicePools } from './service-pools';

const POOLS = parseServicePools('user:4,scripts:2');
const LEASE: NodeLease = { service: 'user', node: 3, leaseId: 'lease-a' };

/**
 * The SQL itself is exercised against real Postgres in the lease integration suite — a fake cannot
 * evaluate `FOR UPDATE SKIP LOCKED` or the reclaim guard. What is worth pinning here is everything
 * the repository decides *outside* the statement.
 */
function fakeDb(rows: Array<Record<string, unknown>> = []) {
  const execute = vi.fn(() => Promise.resolve({ rows }));
  const db = {
    execute,
    transaction: vi.fn((fn: (tx: { execute: typeof execute }) => unknown) => Promise.resolve(fn({ execute }))),
  };
  return { db: db as unknown as DrizzleDB, execute, transaction: db.transaction };
}

function repository(db: DrizzleDB) {
  return new DrizzleNodeIdLeaseRepository(db, POOLS, 30, 5_000);
}

describe('DrizzleNodeIdLeaseRepository', () => {
  describe('acquire', () => {
    // Acquire seeds the pool on first contact, so an unknown name must be refused before the
    // statement runs — otherwise a typo silently mints a pool nobody else leases from.
    it('refuses an undeclared service without opening a transaction', async () => {
      const { db, transaction } = fakeDb();

      await expect(repository(db).acquire('usr', 'holder-1')).rejects.toThrow(UnknownServicePoolError);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('returns null when every node is held or still inside its skew guard', async () => {
      const { db } = fakeDb([]);

      await expect(repository(db).acquire('user', 'holder-1')).resolves.toBeNull();
    });

    it('seeds the pool and claims a node in one transaction', async () => {
      const { db, execute, transaction } = fakeDb([{ node: 2, lease_id: 'lease-b' }]);

      await expect(repository(db).acquire('user', 'holder-1')).resolves.toEqual({
        service: 'user',
        node: 2,
        leaseId: 'lease-b',
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    // pg hands back some integer types as strings; a node id that reached the codec as one would
    // shift every bit above it.
    it('coerces a driver-stringified node id', async () => {
      const { db } = fakeDb([{ node: '2', lease_id: 'lease-b' }]);

      const lease = await repository(db).acquire('user', 'holder-1');
      expect(lease?.node).toBe(2);
    });
  });

  describe('renew', () => {
    it('reports the lease still held when the row matched', async () => {
      const { db } = fakeDb([{ node: 3 }]);

      await expect(repository(db).renew(LEASE, 1_756_000_000_000)).resolves.toBe(true);
    });

    // No row means the row no longer carries this lease_id. The one signal that fences immediately.
    it('reports the lease gone when nothing matched', async () => {
      const { db } = fakeDb([]);

      await expect(repository(db).renew(LEASE, 1_756_000_000_000)).resolves.toBe(false);
    });
  });

  it('releases without caring whether the row was still ours', async () => {
    const { db, execute } = fakeDb([]);

    await expect(repository(db).release(LEASE, 1_756_000_000_000)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
