import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import {
  PROVIDER_UNAVAILABLE,
  cancelOutcomeOf,
  captureOutcomeOf,
  isProviderUnavailable,
  paymentRoutes,
  paymentStatusesOf,
  sessionOutcomeOf,
} from '@jcool/internal-contracts';
import { correlationHeaders } from '@jcool/platform/observability';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';
import {
  PaymentProviderUnavailableError,
  type OrderPaymentParticipantPort,
  type OrderPaymentStatus,
  type PaymentCancelOutcome,
  type PaymentCaptureOutcome,
  type PaymentSessionInput,
  type PaymentSessionResult,
} from '../application/ports/order-payment-participant.port';

export const PAYMENT_SERVICE_BREAKER = 'payment-service';

// Above the command deadline, so a slow call ends on its abort signal rather than the breaker.
const BREAKER_HEADROOM_MS = 1_000;

export interface PaymentServiceOptions {
  url: string;
  token: string;
  /** Covers every Stripe call one command may chain on the other side. */
  commandTimeoutMs: number;
}

type CallOptions = Parameters<OrderPaymentParticipantPort['capture']>[1];

/** The payment-service answered, but not with an outcome the contract names. */
export class PaymentServiceRejection extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code?: string,
  ) {
    super(`payment-service ${path} answered ${status}${code ? ` ${code}` : ''} with no outcome the contract names`);
    this.name = 'PaymentServiceRejection';
  }
}

// A body that is not JSON is still an answer; a read cut off by the deadline or the caller is not.
function unparsedAsNull(error: unknown): null {
  if (error instanceof SyntaxError) return null;
  throw error;
}

/**
 * Only a 5xx or no answer at all says the service is unwell; a 409, a 429 or another 4xx is an answer.
 * Neither is Stripe being away: the service still answers, and status reads and cancels need no Stripe.
 */
export function isPaymentServiceFault(error: unknown): boolean {
  if (!(error instanceof PaymentServiceRejection)) return true;
  return error.status >= 500 && error.code !== PROVIDER_UNAVAILABLE;
}

/**
 * Payment over the payment-service's internal API. Anything but a contract outcome is thrown and the
 * activity's retry policy is the retry, which is safe because every route is idempotent per order.
 */
export class OrderPaymentParticipantHttpAdapter implements OrderPaymentParticipantPort {
  constructor(
    private readonly options: PaymentServiceOptions,
    private readonly breaker: OutboundCall,
    private readonly cls: ClsService,
  ) {}

  // /pay has no retry behind it, so every failure reads as the provider being away (a 502 there).
  async openSession(
    { orderId, amountMinor, currency, expiresAt }: PaymentSessionInput,
    { signal }: CallOptions = {},
  ): Promise<PaymentSessionResult> {
    const body = { amountMinor, currency, expiresAt: expiresAt.toISOString() };
    try {
      return await this.post(paymentRoutes.session(orderId), body, signal, sessionOutcomeOf);
    } catch (error) {
      throw new PaymentProviderUnavailableError({ cause: error });
    }
  }

  capture(orderId: string, { signal }: CallOptions = {}): Promise<PaymentCaptureOutcome> {
    return this.post(paymentRoutes.capture(orderId), undefined, signal, captureOutcomeOf);
  }

  cancel(orderId: string, { signal }: CallOptions = {}): Promise<PaymentCancelOutcome> {
    return this.post(paymentRoutes.cancel(orderId), undefined, signal, cancelOutcomeOf);
  }

  statusOf(orderIds: string[], { signal }: CallOptions = {}): Promise<Map<string, OrderPaymentStatus>> {
    if (orderIds.length === 0) return Promise.resolve(new Map<string, OrderPaymentStatus>());
    return this.post(paymentRoutes.status, { orderIds }, signal, (status, body) =>
      status === 200 ? paymentStatusesOf(body, orderIds) : undefined,
    );
  }

  private post<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    read: (status: number, body: unknown) => T | undefined,
  ): Promise<T> {
    return this.breaker.run(async () => {
      const deadline = AbortSignal.timeout(this.options.commandTimeoutMs);
      const response = await fetch(new URL(path, this.options.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          ...correlationHeaders(this.cls),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
      const parsed: unknown = await response.json().catch(unparsedAsNull);
      const answer = read(response.status, parsed);
      if (answer !== undefined) return answer;
      const code = isProviderUnavailable(response.status, parsed) ? PROVIDER_UNAVAILABLE : undefined;
      throw new PaymentServiceRejection(response.status, path, code);
    });
  }
}

export function createPaymentServiceAdapter(
  config: ConfigService,
  breakers: CircuitBreakerFactory,
  cls: ClsService,
): OrderPaymentParticipantHttpAdapter {
  const commandTimeoutMs = config.getOrThrow<number>('paymentService.commandTimeoutMs');
  return new OrderPaymentParticipantHttpAdapter(
    {
      url: config.getOrThrow<string>('paymentService.url'),
      token: config.getOrThrow<string>('paymentService.token'),
      commandTimeoutMs,
    },
    breakers.create(PAYMENT_SERVICE_BREAKER, {
      timeoutMs: commandTimeoutMs + BREAKER_HEADROOM_MS,
      isDownstreamFault: isPaymentServiceFault,
    }),
    cls,
  );
}
