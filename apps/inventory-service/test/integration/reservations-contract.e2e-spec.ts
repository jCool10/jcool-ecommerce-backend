import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, it } from 'vitest';
import {
  INVENTORY_CONTRACT_CASES,
  type InventoryContractDriver,
  httpContractDriver,
  runContractCase,
} from '@jcool/internal-contracts/testing';
import { E2E_CALLER_TOKEN } from '../setup/e2e-env';
import { getStockView, holdRowLock, seedStock } from '../setup/fixtures/inventory.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

// Short, so a case on a busy row waits it out quickly; every other case finishes well inside it.
const BUDGET_MS = 600;
const LOCK_STOCK_ROW = 'SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE';

describe.each(['pessimistic', 'optimistic'])('Inventory contract over the internal API (%s)', (strategy) => {
  let app: INestApplication;
  let pool: Pool;
  let driver: InventoryContractDriver;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({
      INVENTORY_LOCK_STRATEGY: strategy,
      INVENTORY_TRY_LOCK_TIMEOUT_MS: String(BUDGET_MS),
    }));
    driver = httpContractDriver({
      baseUrl: await app.getUrl(),
      token: E2E_CALLER_TOKEN,
      newId: testId,
      seedStock: async (variantId, onHand) => void (await seedStock(app, variantId, onHand)),
      stockOf: async (variantId) => {
        const view = await getStockView(app, variantId);
        return view && { onHand: view.onHand, reserved: view.reserved };
      },
      lockStock: (variantId) => holdRowLock(pool, LOCK_STOCK_ROW, [variantId]),
    });
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it.each(INVENTORY_CONTRACT_CASES)('$name', (contractCase) => runContractCase(driver, contractCase));
});
