import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import {
  CHECKOUT_DEADLINE_ATTRIBUTE,
  CHECKOUT_STEP_ATTRIBUTE,
} from '../../src/modules/order/saga/checkout-saga.contract';

// The CLI dev server: in-memory persistence and SQLite visibility, so it boots in a second or two.
// Postgres-backed Temporal is exercised by the compose stack instead.
const TEMPORAL_IMAGE = 'temporalio/temporal:1.9.1';
const FRONTEND_PORT = 7233;
export const TEMPORAL_E2E_NAMESPACE = 'jcool';

const WORKFLOWS_PATH = resolve(__dirname, '../../src/modules/order/saga/workflows');

export interface StartedTemporal {
  address: string;
  stop: () => Promise<void>;
}

export async function startTemporalServer(): Promise<StartedTemporal> {
  const container: StartedTestContainer = await new GenericContainer(TEMPORAL_IMAGE)
    .withCommand([
      'server',
      'start-dev',
      '--ip',
      '0.0.0.0',
      '--namespace',
      TEMPORAL_E2E_NAMESPACE,
      '--search-attribute',
      `${CHECKOUT_STEP_ATTRIBUTE.name}=Keyword`,
      '--search-attribute',
      `${CHECKOUT_DEADLINE_ATTRIBUTE.name}=Datetime`,
    ])
    .withExposedPorts(FRONTEND_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Temporal Server:/))
    .start();
  return {
    address: `${container.getHost()}:${container.getMappedPort(FRONTEND_PORT)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface BuiltWorkflowBundle {
  path: string;
  remove: () => Promise<void>;
}

/** Once per run: `Worker.create({ workflowsPath })` would run webpack again for every app. */
export async function bundleWorkflowsOnce(): Promise<BuiltWorkflowBundle> {
  const dir = await mkdtemp(join(tmpdir(), 'jcool-e2e-workflows-'));
  const path = join(dir, 'checkout-saga.bundle.js');
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: new DefaultLogger('WARN') });
  await writeFile(path, code);
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}
