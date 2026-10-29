import type { PaymentContractDriver } from './contract-cases';
import {
  cancelOutcomeOf,
  captureOutcomeOf,
  isProviderUnavailable,
  paymentStatusesOf,
  sessionOutcomeOf,
} from './guards';
import { paymentRoutes } from './routes';
import { PROVIDER_UNAVAILABLE } from './types';

export interface PaymentHttpContractDriverOptions {
  baseUrl: string;
  token: string;
  newId(): string;
  sessionFloorMs: number;
  /** The buyer's side of a payment happens outside the internal API, so each runner pays its own way. */
  authorize(orderId: string): Promise<void>;
  /** Stripe sits behind the API too, so each runner fails it its own way. */
  stripeFailsCapture(orderId: string): Promise<void>;
}

interface Answer {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

// Stripe being away is only an answer with the retry hint the contract promises alongside it.
const providerDownOf = ({ status, body, retryAfter }: Answer) =>
  isProviderUnavailable(status, body) && retryAfter !== null ? PROVIDER_UNAVAILABLE : undefined;

/** Drives the internal API exactly as a caller would, failing on any status the contract does not name. */
export function paymentHttpContractDriver({
  baseUrl,
  token,
  ...arrange
}: PaymentHttpContractDriverOptions): PaymentContractDriver {
  const post = async (path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as unknown,
      retryAfter: response.headers.get('retry-after'),
    };
  };
  const unexpected = (path: string, answer: Answer) =>
    new Error(`${path} answered ${answer.status} ${JSON.stringify(answer.body)}`);
  const expectOutcome = async <T>(path: string, read: (answer: Answer) => T | undefined, body?: unknown) => {
    const answer = await post(path, body);
    const outcome = read(answer);
    if (outcome === undefined) throw unexpected(path, answer);
    return outcome;
  };

  return {
    ...arrange,
    openSession: (orderId, { amountMinor, currency, expiresAt }) =>
      expectOutcome(paymentRoutes.session(orderId), ({ status, body }) => sessionOutcomeOf(status, body), {
        amountMinor,
        currency,
        expiresAt: expiresAt.toISOString(),
      }),
    capture: (orderId) =>
      expectOutcome(
        paymentRoutes.capture(orderId),
        (answer) => captureOutcomeOf(answer.status, answer.body) ?? providerDownOf(answer),
      ),
    cancel: (orderId) =>
      expectOutcome(paymentRoutes.cancel(orderId), ({ status, body }) => cancelOutcomeOf(status, body)),
    statusOf: (orderIds) =>
      expectOutcome(
        paymentRoutes.status,
        ({ status, body }) => (status === 200 ? paymentStatusesOf(body, orderIds) : undefined),
        { orderIds },
      ),
  };
}
