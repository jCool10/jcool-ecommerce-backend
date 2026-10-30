import { beforeAll, beforeEach, describe, it } from 'vitest';
import {
  PAYMENT_CONTRACT_CASES,
  type PaymentContractDriver,
  paymentHttpContractDriver,
  runPaymentContractCase,
} from '@jcool/internal-contracts/testing';
import { testId } from '../setup/id-service-stub';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';

// The same table the real payment-service passes, so a saga suite green on the stub is green on it.
describe('Payment-service stub against the shared contract', () => {
  let stub: PaymentServiceStub;
  let driver: PaymentContractDriver;

  beforeAll(async () => {
    stub = await paymentServiceStub();
    driver = paymentHttpContractDriver({
      baseUrl: stub.url,
      token: process.env.PAYMENT_SERVICE_TOKEN ?? '',
      newId: testId,
      sessionFloorMs: stub.sessionFloorMs,
      authorize: async (orderId) => {
        await stub.authorize(orderId);
      },
      // Per route on the stub, which is enough: a case drives one order at a time.
      stripeFailsCapture: () => {
        stub.providerDown('capture');
        return Promise.resolve();
      },
    });
  });
  beforeEach(() => stub.reset());

  it.each(PAYMENT_CONTRACT_CASES)('$name', (contractCase) => runPaymentContractCase(driver, contractCase));
});
