import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException, ValidationPipe, type Type } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { MAX_STATUS_BATCH } from '@jcool/internal-contracts';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import {
  PaymentGatewayError,
  type PaymentParticipant,
  type PaymentParticipantStatus,
} from '../../application/public/payment-participant.port';
import { OpenSessionDto, PaymentStatusDto } from './dto';
import { PaymentsController } from './payments.controller';

// Routable ids: decimal strings that decode to a node the id service hands out.
const ORDER_ID = '137465797020397179';
const OTHER_ORDER_ID = '137465797020397180';
const PAYMENT_ID = '137465797020397181';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const validated = <T>(metatype: Type<T>, body: unknown): Promise<T> =>
  pipe.transform(body, { type: 'body', metatype }) as Promise<T>;

const isRefused = (run: () => unknown): Promise<boolean> =>
  Promise.resolve()
    .then(run)
    .then(
      () => false,
      (error: unknown) => error instanceof BadRequestException,
    );

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

const sessionBody = (overrides: Record<string, unknown> = {}) => ({
  amountMinor: 125_000,
  currency: 'VND',
  expiresAt: inAnHour(),
  ...overrides,
});

function fakeResponse() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function build(overrides: Partial<PaymentParticipant> = {}) {
  const participant = {
    openSession: vi.fn<PaymentParticipant['openSession']>(
      overrides.openSession ?? (() => Promise.resolve({ outcome: 'CLOSED' })),
    ),
    capture: vi.fn<PaymentParticipant['capture']>(overrides.capture ?? (() => Promise.resolve('CAPTURED'))),
    cancel: vi.fn<PaymentParticipant['cancel']>(overrides.cancel ?? (() => Promise.resolve('CANCELLED'))),
    statusOf: vi.fn<PaymentParticipant['statusOf']>(overrides.statusOf ?? (() => Promise.resolve(new Map()))),
  };
  return { controller: new PaymentsController(participant), participant };
}

describe('PaymentsController validation', () => {
  it('accepts a well-formed session request', async () => {
    expect(await isRefused(() => validated(OpenSessionDto, sessionBody()))).toBe(false);
  });

  it.each([
    ['a zero amount', { amountMinor: 0 }],
    ['a negative amount', { amountMinor: -1 }],
    ['a fractional amount', { amountMinor: 1.5 }],
    ['an amount sent as a string', { amountMinor: '125000' }],
    ['a currency that is not three letters', { currency: 'DONG' }],
    ['a numeric currency', { currency: '704' }],
    ['an expiresAt that is not an ISO timestamp', { expiresAt: 'tomorrow' }],
    ['an unknown field', { reason: 'checkout' }],
  ])('refuses a session request with %s', async (_case, overrides) => {
    expect(await isRefused(() => validated(OpenSessionDto, sessionBody(overrides)))).toBe(true);
  });

  // The floor is the participant's call, answered CLOSED; validation only checks the shape.
  it('lets an expiresAt in the past through to the participant', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();

    expect(await isRefused(() => validated(OpenSessionDto, sessionBody({ expiresAt: past })))).toBe(false);
  });

  it('takes 1 to 200 routable order ids in a status batch', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => ORDER_ID);

    const answers = await Promise.all(
      [ids(1), ids(MAX_STATUS_BATCH), [], ids(MAX_STATUS_BATCH + 1), ['order-1']].map((orderIds) =>
        isRefused(() => validated(PaymentStatusDto, { orderIds })),
      ),
    );

    expect(answers).toEqual([false, false, true, true, true]);
  });

  it('refuses an order id in the path that is not routable', async () => {
    expect(await isRefused(() => new ParseSnowflakeIdPipe().transform('42'))).toBe(true);
  });
});

describe('PaymentsController answers', () => {
  it('answers an opened session with 200 and the attempt it belongs to', async () => {
    const opened = {
      outcome: 'OPENED' as const,
      paymentId: PAYMENT_ID,
      providerSessionId: 'cs_test_1',
      redirectUrl: 'https://checkout.stripe.test/cs_test_1',
      clientSecret: 'cs_test_1_secret',
    };
    const { controller, participant } = build({ openSession: () => Promise.resolve(opened) });
    const res = fakeResponse();
    const expiresAt = inAnHour();
    const body = await validated(OpenSessionDto, sessionBody({ expiresAt }));

    await controller.openSession(ORDER_ID, body, res as unknown as Response);

    expect(participant.openSession).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      amountMinor: 125_000,
      currency: 'VND',
      expiresAt: new Date(expiresAt),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(opened);
  });

  it('answers a closed session with 409', async () => {
    const { controller } = build({ openSession: () => Promise.resolve({ outcome: 'CLOSED' }) });
    const res = fakeResponse();

    await controller.openSession(ORDER_ID, await validated(OpenSessionDto, sessionBody()), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ outcome: 'CLOSED' });
  });

  it.each([
    ['capture', 'CAPTURED', 200],
    ['capture', 'IDEMPOTENT', 200],
    ['capture', 'NOT_CAPTURABLE', 409],
    ['capture', 'CONFLICT', 409],
    ['cancel', 'CANCELLED', 200],
    ['cancel', 'FENCED', 200],
    ['cancel', 'IDEMPOTENT', 200],
    ['cancel', 'CAPTURED_CONFLICT', 409],
  ] as const)('answers %s that came out %s with %d', async (command, outcome, status) => {
    const { controller, participant } = build({ [command]: () => Promise.resolve(outcome) });
    const res = fakeResponse();

    await controller[command](ORDER_ID, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ outcome });
    expect(participant[command]).toHaveBeenCalledWith({ orderId: ORDER_ID });
  });

  it('answers every id asked for, a null header where payment never saw the order', async () => {
    const held: PaymentParticipantStatus = {
      header: 'AUTHORIZED',
      authorizedPaymentId: PAYMENT_ID,
      hasAuthorizedAttempt: true,
      hasSucceededAttempt: false,
    };
    const unknown: PaymentParticipantStatus = {
      header: null,
      authorizedPaymentId: null,
      hasAuthorizedAttempt: false,
      hasSucceededAttempt: false,
    };
    const { controller } = build({
      statusOf: () =>
        Promise.resolve(
          new Map([
            [ORDER_ID, held],
            [OTHER_ORDER_ID, unknown],
          ]),
        ),
    });

    const answer = await controller.status(
      { orderIds: [ORDER_ID, OTHER_ORDER_ID] },
      fakeResponse() as unknown as Response,
    );

    expect(answer).toEqual({ statuses: { [ORDER_ID]: held, [OTHER_ORDER_ID]: unknown } });
  });

  async function failOn(route: 'openSession' | 'capture' | 'cancel' | 'status', fault: Error) {
    const { controller } = build({
      openSession: () => Promise.reject(fault),
      capture: () => Promise.reject(fault),
      cancel: () => Promise.reject(fault),
      statusOf: () => Promise.reject(fault),
    });
    const res = fakeResponse();
    const body = await validated(OpenSessionDto, sessionBody());
    const run = {
      openSession: () => controller.openSession(ORDER_ID, body, res as unknown as Response),
      capture: () => controller.capture(ORDER_ID, res as unknown as Response),
      cancel: () => controller.cancel(ORDER_ID, res as unknown as Response),
      status: () => controller.status({ orderIds: [ORDER_ID] }, res as unknown as Response),
    }[route];
    return { error: await run().catch((caught: unknown) => caught), res };
  }

  it.each(['openSession', 'capture', 'cancel', 'status'] as const)(
    'turns a fault the participant throws on %s into a 503 the caller retries after a second',
    async (route) => {
      const fault = new Error('connection terminated');

      const { error, res } = await failOn(route, fault);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).cause).toBe(fault);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(res.json).not.toHaveBeenCalled();
    },
  );

  it.each(['openSession', 'capture', 'cancel'] as const)(
    'leaves a Stripe failure on %s to the filter that names it, after a second',
    async (route) => {
      const fault = new PaymentGatewayError('gateway could not capture: timeout');

      const { error, res } = await failOn(route, fault);

      expect(error).toBe(fault);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(res.json).not.toHaveBeenCalled();
    },
  );
});
