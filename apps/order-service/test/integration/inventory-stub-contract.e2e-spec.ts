import { beforeAll, beforeEach, describe, it } from 'vitest';
import {
  INVENTORY_CONTRACT_CASES,
  type InventoryContractDriver,
  httpContractDriver,
  runContractCase,
} from '@jcool/internal-contracts/testing';
import { testId } from '../setup/id-service-stub';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';

// The same table the real inventory-service passes, so a saga suite green on the stub is green on it.
describe('Inventory-service stub against the shared contract', () => {
  let stub: InventoryServiceStub;
  let driver: InventoryContractDriver;

  beforeAll(async () => {
    stub = await inventoryServiceStub();
    driver = httpContractDriver({
      baseUrl: stub.url,
      token: process.env.INVENTORY_SERVICE_TOKEN ?? '',
      newId: testId,
      seedStock: (variantId, onHand) => Promise.resolve(stub.seedStock(variantId, onHand)),
      stockOf: (variantId) => {
        const level = stub.stockOf(variantId);
        return Promise.resolve(level ? { onHand: level.onHand, reserved: level.reserved } : null);
      },
      lockStock: (variantId) => {
        const unlock = stub.lockStock(variantId);
        return Promise.resolve(() => Promise.resolve(unlock()));
      },
    });
  });
  beforeEach(() => stub.reset());

  it.each(INVENTORY_CONTRACT_CASES)('$name', (contractCase) => runContractCase(driver, contractCase));
});
