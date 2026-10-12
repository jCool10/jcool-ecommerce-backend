import { noop } from 'cockatiel';
import { Etcd3 } from 'etcd3';

export const ETCD_CLIENT = Symbol('ETCD_CLIENT');

// No client-side retry or circuit breaker: the lease keeper owns the retry schedule, a retried call
// would outlive the per-call deadline, and an open breaker keeps failing calls after etcd is back.
export function createEtcdClient(endpoints: string[]): Etcd3 {
  if (endpoints.length === 0) throw new RangeError('ETCD_ENDPOINTS lists no endpoint');
  return new Etcd3({ hosts: endpoints, faultHandling: { host: () => noop, global: noop } });
}
