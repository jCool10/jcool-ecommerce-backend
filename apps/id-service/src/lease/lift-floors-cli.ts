import { etcdConfig } from '../config/configuration';
import { createEtcdClient } from '../etcd/etcd-client';
import { liftFloors } from './lift-floors';

// `--if-uninitialized` is the pre-deploy form: a no-op on a keyspace already given floors, so a
// rolling deploy never trips over the replicas it is replacing.
const onlyIfUninitialized = process.argv.includes('--if-uninitialized');
const { endpoints, keyPrefix, requestTimeoutMs } = etcdConfig();
const etcd = createEtcdClient(endpoints);

liftFloors(etcd, { keyPrefix, requestTimeoutMs, nowMs: Date.now(), onlyIfUninitialized })
  .then((outcome) => {
    console.log(
      outcome.kind === 'lifted'
        ? `floors under ${keyPrefix} lifted to ${outcome.floorMs}`
        : `floors under ${keyPrefix} already initialized; nothing to do`,
    );
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error('floor lift failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => etcd.close());
