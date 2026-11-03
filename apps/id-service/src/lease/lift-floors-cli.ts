import { setTimeout as sleep } from 'node:timers/promises';
import { etcdConfig, leaseTtlMs } from '../config/configuration';
import { createEtcdClient } from '../etcd/etcd-client';
import { LiftSettlingError, liftFloors, type LiftOutcome } from './lift-floors';

// `--if-uninitialized` is the pre-deploy form: a no-op on a keyspace already given floors, so a
// rolling deploy never trips over the replicas it is replacing.
const onlyIfUninitialized = process.argv.includes('--if-uninitialized');
// `--settle` enforces the RUNBOOK's wait: no lift until a full lease TTL has passed since the keyspace was
// first seen empty, so an unattended pre-deploy cannot lift under a replica that is still minting. The run
// waits that out itself; if the platform kills it first, the recorded sighting lets the next deploy finish.
const settleMs = process.argv.includes('--settle') ? leaseTtlMs() : 0;
const { endpoints, keyPrefix, requestTimeoutMs } = etcdConfig();
const etcd = createEtcdClient(endpoints);

async function lift(): Promise<LiftOutcome> {
  for (;;) {
    try {
      return await liftFloors(etcd, { keyPrefix, requestTimeoutMs, nowMs: Date.now(), onlyIfUninitialized, settleMs });
    } catch (error) {
      if (!(error instanceof LiftSettlingError)) throw error;
      console.log(`floor lift waiting ${Math.ceil(error.remainingMs / 1000)}s: ${error.message}`);
      await sleep(error.remainingMs + 1_000);
    }
  }
}

lift()
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
