import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import {
  PaymentGatewayError,
  type CaptureResult,
  type IntentStatus,
  type VoidOutcome,
} from '../../application/ports/payment-gateway.port';
import { captureOutcomeAfterFault, voidOutcomeAfterFault } from './stripe-fault-classification';

/** How the next capture or void on an intent goes wrong, in the ways Stripe can. */
export type IntentFault = 'server_error' | 'applied_then_500' | 'timeout' | 'idempotency_in_flight';

interface Hold {
  status: IntentStatus;
  amountMinor: number;
  currency: string;
  captures: number;
  voided: boolean;
  keys: string[];
}

type Call = 'capture' | 'void';

/**
 * PaymentIntents with Stripe's idempotency rules: the first response under a key, a 500 included, is
 * stored and replayed for every resend of it, while a timeout or an in-flight 409 stores nothing. A
 * faulted call resolves through the same read-back mapping the real adapter uses.
 */
export class FakePaymentIntents {
  private readonly holds = new Map<string, Hold>();
  private readonly stored = new Map<string, 'ok' | 'failed'>();
  private readonly faults = new Map<string, IntentFault>();

  open(amountMinor: number, currency: string): string {
    const intentId = `pi_fake_${uuidv7().replace(/-/g, '')}`;
    this.holds.set(intentId, {
      status: 'requires_capture',
      amountMinor,
      currency,
      captures: 0,
      voided: false,
      keys: [],
    });
    return intentId;
  }

  find(intentId: string): Readonly<Hold> | undefined {
    return this.holds.get(intentId);
  }

  setStatus(intentId: string, status: IntentStatus): void {
    this.hold(intentId).status = status;
  }

  failNext(call: Call, intentId: string, fault: IntentFault): void {
    this.faults.set(`${call}:${intentId}`, fault);
  }

  captureCalls(intentId: string): number {
    return this.holds.get(intentId)?.captures ?? 0;
  }

  wasVoided(intentId: string): boolean {
    return this.holds.get(intentId)?.voided ?? false;
  }

  requestKeys(intentId: string): readonly string[] {
    return this.holds.get(intentId)?.keys ?? [];
  }

  capture(intentId: string, key: string): Promise<CaptureResult> {
    return asPromise(() =>
      this.execute('capture', intentId, key, {
        apply: (hold) => {
          if (hold.status !== 'requires_capture') return false;
          hold.status = 'succeeded';
          hold.captures += 1;
          return true;
        },
        applied: { kind: 'captured' },
        readBack: captureOutcomeAfterFault,
      }),
    );
  }

  void(intentId: string, key: string): Promise<VoidOutcome> {
    return asPromise(() =>
      this.execute('void', intentId, key, {
        apply: (hold) => {
          if (hold.status === 'succeeded' || hold.status === 'canceled') return false;
          hold.status = 'canceled';
          hold.voided = true;
          return true;
        },
        applied: 'voided',
        readBack: voidOutcomeAfterFault,
      }),
    );
  }

  private execute<T>(
    call: Call,
    intentId: string,
    key: string,
    rules: { apply: (hold: Hold) => boolean; applied: T; readBack: (status: IntentStatus, fault: unknown) => T },
  ): T {
    const hold = this.hold(intentId);
    hold.keys.push(key);
    const failed = (fault: unknown): T => {
      this.stored.set(key, 'failed');
      return rules.readBack(hold.status, fault);
    };

    const stored = this.stored.get(key);
    if (stored === 'ok') return rules.applied;
    if (stored === 'failed') return failed(serverError());

    const fault = this.faults.get(`${call}:${intentId}`);
    this.faults.delete(`${call}:${intentId}`);
    switch (fault) {
      case 'timeout':
        throw new PaymentGatewayError(`fake ${call} timed out`, timeoutError());
      case 'idempotency_in_flight':
        throw new PaymentGatewayError(`fake ${call} key still in flight`, inFlightError());
      case 'server_error':
        return failed(serverError());
      case 'applied_then_500':
        rules.apply(hold);
        return failed(serverError());
    }

    if (!rules.apply(hold)) return failed(unexpectedStateError());
    this.stored.set(key, 'ok');
    return rules.applied;
  }

  private hold(intentId: string): Hold {
    const hold = this.holds.get(intentId);
    if (!hold) throw new PaymentGatewayError(`fake gateway has no intent ${intentId}`);
    return hold;
  }
}

const asPromise = <T>(run: () => T): Promise<T> => new Promise((resolve) => resolve(run()));

const serverError = () =>
  Stripe.errors.StripeError.generate({ type: 'api_error', statusCode: 500, message: 'fake gateway 500' });
const inFlightError = () =>
  Stripe.errors.StripeError.generate({ type: 'idempotency_error', statusCode: 409, message: 'fake key in flight' });
const unexpectedStateError = () =>
  Stripe.errors.StripeError.generate({
    type: 'invalid_request_error',
    statusCode: 400,
    code: 'payment_intent_unexpected_state',
    message: 'fake intent in the wrong state',
  });
const timeoutError = () =>
  new Stripe.errors.StripeConnectionError({ message: 'Request aborted due to timeout being reached' });
