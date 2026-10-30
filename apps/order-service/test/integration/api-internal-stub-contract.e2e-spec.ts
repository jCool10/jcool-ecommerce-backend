import { beforeAll, beforeEach, describe, it } from 'vitest';
import {
  API_READ_CONTRACT_CASES,
  type ApiReadContractDriver,
  apiReadHttpContractDriver,
  runApiReadContractCase,
} from '@jcool/internal-contracts/testing';
import { type ApiInternalStub, apiInternalStub } from '../setup/api-internal-stub';
import { testId } from '../setup/id-service-stub';

// The same table the api's own read routes pass, so a checkout suite green on the stub is green on it.
describe('Api internal-read stub against the shared contract', () => {
  let stub: ApiInternalStub;
  let driver: ApiReadContractDriver;

  beforeAll(async () => {
    stub = await apiInternalStub();
    driver = apiReadHttpContractDriver({
      baseUrl: stub.url,
      token: process.env.API_SERVICE_TOKEN ?? '',
      newId: testId,
      seedSku: (seed) => Promise.resolve(stub.seedCatalogSku(seed)),
      seedCart: (lines) => {
        const userId = testId();
        for (const { skuId, quantity } of lines) stub.addLine(userId, skuId, quantity);
        return Promise.resolve(userId);
      },
    });
  });
  beforeEach(() => stub.reset());

  it.each(API_READ_CONTRACT_CASES)('$name', (contractCase) => runApiReadContractCase(driver, contractCase));
});
