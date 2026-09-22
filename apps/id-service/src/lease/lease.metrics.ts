import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import { LEASE_STATES, type NodeLease } from '@jcool/id-generator';

export const ID_LEASE_STATE = 'id_lease_state';
export const ID_LEASE_NODE_INFO = 'id_lease_node_info';
export const ID_LEASE_RENEW_FAILURES_TOTAL = 'id_lease_renew_failures_total';
export const ID_LEASE_LOST_TOTAL = 'id_lease_lost_total';
export const ID_LEASE_FLOOR_REJECTIONS_TOTAL = 'id_lease_floor_rejections_total';

// Module-level for the same reason as the identity-clock collector: the registry get-or-creates by
// name, so a collect closure over an injected lease would keep reading the first app built.
let bound: NodeLease | null = null;

export function bindLeaseMetrics(lease: NodeLease): void {
  bound = lease;
}

export function unbindLeaseMetrics(lease: NodeLease): void {
  if (bound === lease) bound = null;
}

export const LEASE_METRIC_PROVIDERS: Provider[] = [
  makeGaugeProvider({
    name: ID_LEASE_STATE,
    help: 'Node lease state of this replica: 1 on the current state, 0 on the rest. Only held and draining mint.',
    labelNames: ['state'],
    collect(this: Gauge<string>) {
      this.reset();
      if (bound === null) return;
      const current = bound.state;
      for (const state of LEASE_STATES) this.set({ state }, state === current ? 1 : 0);
    },
  }),
  // The node id as a label on its own series, not on every counter: a counter relabelled at each
  // re-acquire would restart from zero under the new label.
  makeGaugeProvider({
    name: ID_LEASE_NODE_INFO,
    help: 'Always 1, labelled with the node id this replica currently holds; absent while it holds none.',
    labelNames: ['node_id'],
    collect(this: Gauge<string>) {
      this.reset();
      const nodeId = bound?.nodeId;
      if (nodeId !== undefined) this.set({ node_id: String(nodeId) }, 1);
    },
  }),
  makeCounterProvider({
    name: ID_LEASE_RENEW_FAILURES_TOTAL,
    help: 'Renewals that failed to reach the lease store. The replica keeps minting until its fence.',
  }),
  makeCounterProvider({
    name: ID_LEASE_LOST_TOTAL,
    help: 'Renewals that found the lease expired or taken; minting stopped at once and a new node was sought.',
  }),
  makeCounterProvider({
    name: ID_LEASE_FLOOR_REJECTIONS_TOTAL,
    help: "Nodes handed back at acquire because a previous holder's last timestamp sat too far ahead of the database clock.",
  }),
];
