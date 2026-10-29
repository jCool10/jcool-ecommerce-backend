import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { beforeAll, describe, it } from 'vitest';
import {
  PAYMENT_CONTRACT_CASES,
  type PaymentContractDriver,
  paymentHttpContractDriver,
  runPaymentContractCase,
} from '@jcool/internal-contracts/testing';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { E2E_API_CALLER_TOKEN } from '../setup/e2e-env';
import { authorizeSession, readPayment } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const WEBHOOK_SECRET = 'whsec_e2e_payments_contract_0001';

// The table the api's stub of this service must pass too.
describe('Payment contract over the internal API (fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let driver: PaymentContractDriver;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    const config = app.get(ConfigService);
    driver = paymentHttpContractDriver({
      baseUrl: await app.getUrl(),
      token: E2E_API_CALLER_TOKEN,
      newId: testId,
      sessionFloorMs:
        (config.getOrThrow<number>('payment.sessionMinTtlSec') +
          config.getOrThrow<number>('payment.sessionExpiryMarginSec')) *
        1_000,
      authorize: async (orderId) => {
        const { providerSessionId } = await readPayment(app, orderId);
        await authorizeSession(app, providerSessionId, orderId);
      },
      stripeFailsCapture: async (orderId) => {
        const { providerIntentId } = await readPayment(app, orderId);
        if (!providerIntentId) throw new Error(`order ${orderId} has no intent to fail`);
        gateway.failCapture(providerIntentId, 'timeout');
      },
    });
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it.each(PAYMENT_CONTRACT_CASES)('$name', (contractCase) => runPaymentContractCase(driver, contractCase));
});
