import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { describe, expect, it } from 'vitest';
import {
  bindLeaseMetrics,
  ID_LEASE_NODE_INFO,
  ID_LEASE_STATE,
  LEASE_METRIC_PROVIDERS,
  unbindLeaseMetrics,
} from './lease.metrics';
import { FakeLeaseStore } from './testing/fake-lease-store';
import { testNodeLease } from './testing/test-node-lease';

// Through the real factories, as the module registers them; willsoto puts its options token first.
for (const provider of LEASE_METRIC_PROVIDERS as FactoryProvider[]) provider.useFactory(undefined);

async function series(name: string): Promise<string[]> {
  return (await register.metrics()).split('\n').filter((line) => line.startsWith(`${name}{`));
}

describe('lease metrics', () => {
  it('reports nothing while no lease is bound', async () => {
    await expect(series(ID_LEASE_STATE)).resolves.toEqual([]);
    await expect(series(ID_LEASE_NODE_INFO)).resolves.toEqual([]);
  });

  it('marks the current state and the node held, and withdraws the node once it is gone', async () => {
    const lease = testNodeLease(new FakeLeaseStore().grant(12));
    await lease.acquire();
    bindLeaseMetrics(lease);

    await expect(series(ID_LEASE_STATE)).resolves.toContain('id_lease_state{state="held"} 1');
    await expect(series(ID_LEASE_STATE)).resolves.toContain('id_lease_state{state="fenced"} 0');
    await expect(series(ID_LEASE_NODE_INFO)).resolves.toEqual(['id_lease_node_info{node_id="12"} 1']);

    await lease.release();
    await expect(series(ID_LEASE_STATE)).resolves.toContain('id_lease_state{state="released"} 1');
    await expect(series(ID_LEASE_NODE_INFO)).resolves.toEqual([]);
  });

  it('leaves a newer binding alone when an older lease unbinds', async () => {
    const older = testNodeLease(new FakeLeaseStore());
    const newer = testNodeLease(new FakeLeaseStore().grant(3));
    await newer.acquire();
    bindLeaseMetrics(older);
    bindLeaseMetrics(newer);

    unbindLeaseMetrics(older);
    await expect(series(ID_LEASE_NODE_INFO)).resolves.toEqual(['id_lease_node_info{node_id="3"} 1']);

    unbindLeaseMetrics(newer);
    await expect(series(ID_LEASE_STATE)).resolves.toEqual([]);
  });
});
