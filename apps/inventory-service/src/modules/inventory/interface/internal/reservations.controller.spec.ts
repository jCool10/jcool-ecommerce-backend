import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException, ValidationPipe, type Type } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { MAX_STATUS_BATCH } from '@jcool/internal-contracts';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import type { InventoryParticipant } from '../../application/public/inventory-participant.port';
import { ReservationTimeoutError } from '../../domain/errors/reservation-timeout.error';
import { StatusDto, TryReservationDto } from './dto';
import { ReservationsController } from './reservations.controller';

// Routable ids: decimal strings that decode to a node the id service hands out.
const ORDER_ID = '137465797020397179';
const VARIANT_A = '137465797020397180';
const VARIANT_B = '137465797020397181';

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

function fakeResponse() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function build(overrides: Partial<InventoryParticipant> = {}) {
  const participant = {
    tryReserve: vi.fn<InventoryParticipant['tryReserve']>(overrides.tryReserve ?? (() => Promise.resolve('RESERVED'))),
    commit: vi.fn<InventoryParticipant['commit']>(overrides.commit ?? (() => Promise.resolve('APPLIED'))),
    release: vi.fn<InventoryParticipant['release']>(overrides.release ?? (() => Promise.resolve('APPLIED'))),
    restock: vi.fn<InventoryParticipant['restock']>(overrides.restock ?? (() => Promise.resolve('APPLIED'))),
    statusOf: vi.fn<InventoryParticipant['statusOf']>(overrides.statusOf ?? (() => Promise.resolve(new Map()))),
  };
  return { controller: new ReservationsController(participant), participant };
}

describe('ReservationsController validation', () => {
  const tryBody = (overrides: Record<string, unknown> = {}) => ({
    lines: [{ variantId: VARIANT_A, quantity: 2 }],
    holdUntil: inAnHour(),
    ...overrides,
  });

  it('accepts a well-formed Try', async () => {
    expect(await isRefused(() => validated(TryReservationDto, tryBody()))).toBe(false);
  });

  it.each([
    ['a variant id that is not routable', { lines: [{ variantId: 'sku-1', quantity: 1 }] }],
    ['a zero quantity', { lines: [{ variantId: VARIANT_A, quantity: 0 }] }],
    ['a fractional quantity', { lines: [{ variantId: VARIANT_A, quantity: 1.5 }] }],
    ['a quantity sent as a string', { lines: [{ variantId: VARIANT_A, quantity: '2' }] }],
    [
      'two lines for one variant',
      {
        lines: [
          { variantId: VARIANT_A, quantity: 1 },
          { variantId: VARIANT_A, quantity: 1 },
        ],
      },
    ],
    ['no lines', { lines: [] }],
    ['a holdUntil that is not an ISO timestamp', { holdUntil: 'tomorrow' }],
    ['a holdUntil in the past', { holdUntil: new Date(Date.now() - 1_000).toISOString() }],
    ['an unknown field', { reason: 'checkout' }],
  ])('refuses a Try with %s', async (_case, overrides) => {
    expect(await isRefused(() => validated(TryReservationDto, tryBody(overrides)))).toBe(true);
  });

  it('accepts two lines for different variants', async () => {
    const lines = [
      { variantId: VARIANT_A, quantity: 1 },
      { variantId: VARIANT_B, quantity: 3 },
    ];

    expect(await isRefused(() => validated(TryReservationDto, tryBody({ lines })))).toBe(false);
  });

  it('takes 1 to 200 routable order ids in a status batch', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => ORDER_ID);

    const answers = await Promise.all(
      [ids(1), ids(MAX_STATUS_BATCH), [], ids(MAX_STATUS_BATCH + 1), ['order-1']].map((orderIds) =>
        isRefused(() => validated(StatusDto, { orderIds })),
      ),
    );

    expect(answers).toEqual([false, false, true, true, true]);
  });

  it('refuses an order id in the path that is not routable', async () => {
    expect(await isRefused(() => new ParseSnowflakeIdPipe().transform('42'))).toBe(true);
  });
});

describe('ReservationsController answers', () => {
  it.each([
    ['RESERVED', 201],
    ['OUT_OF_STOCK', 409],
    ['CONTENDED', 409],
    ['CONFLICT', 409],
  ] as const)('answers a Try that came out %s with %d', async (outcome, status) => {
    const { controller } = build({ tryReserve: () => Promise.resolve(outcome) });
    const res = fakeResponse();
    const body = await validated(TryReservationDto, {
      lines: [{ variantId: VARIANT_A, quantity: 1 }],
      holdUntil: inAnHour(),
    });

    await controller.tryReserve(ORDER_ID, body, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ outcome });
  });

  it('hands the participant the variant lines and the hold deadline as a date', async () => {
    const { controller, participant } = build();
    const holdUntil = inAnHour();
    const body = await validated(TryReservationDto, { lines: [{ variantId: VARIANT_A, quantity: 2 }], holdUntil });

    await controller.tryReserve(ORDER_ID, body, fakeResponse() as unknown as Response);

    expect(participant.tryReserve).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      lines: [{ variantId: VARIANT_A, quantity: 2 }],
      holdUntil: new Date(holdUntil),
    });
  });

  it.each([
    ['commit', 'APPLIED', 200],
    ['release', 'IDEMPOTENT', 200],
    ['restock', 'CONFLICT', 409],
  ] as const)('answers %s that came out %s with %d', async (command, outcome, status) => {
    const { controller, participant } = build({ [command]: () => Promise.resolve(outcome) });
    const res = fakeResponse();

    await controller[command](ORDER_ID, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ outcome });
    expect(participant[command]).toHaveBeenCalledWith(ORDER_ID);
  });

  it('answers every id asked for, null where there is no header', async () => {
    const { controller } = build({
      statusOf: (ids) => Promise.resolve(new Map(ids.map((id, i) => [id, i === 0 ? 'HELD' : null]))),
    });

    const answer = await controller.status({ orderIds: [ORDER_ID, VARIANT_A] }, fakeResponse() as unknown as Response);

    expect(answer).toEqual({ statuses: { [ORDER_ID]: 'HELD', [VARIANT_A]: null } });
  });

  it.each(['tryReserve', 'commit', 'status'] as const)(
    'turns a fault the participant throws on %s into a 503 the caller retries after a second',
    async (route) => {
      const fault = new Error('lock timeout');
      const { controller } = build({
        tryReserve: () => Promise.reject(fault),
        commit: () => Promise.reject(fault),
        statusOf: () => Promise.reject(fault),
      });
      const res = fakeResponse();
      const body = await validated(TryReservationDto, {
        lines: [{ variantId: VARIANT_A, quantity: 1 }],
        holdUntil: inAnHour(),
      });
      const run = {
        tryReserve: () => controller.tryReserve(ORDER_ID, body, res as unknown as Response),
        commit: () => controller.commit(ORDER_ID, res as unknown as Response),
        status: () => controller.status({ orderIds: [ORDER_ID] }, res as unknown as Response),
      }[route];

      const error = await run().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).cause).toBe(fault);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(res.json).not.toHaveBeenCalled();
    },
  );

  it.each(['tryReserve', 'release'] as const)(
    'leaves a %s that ran out of its lock budget to the filter that answers busy rows',
    async (route) => {
      const timeout = new ReservationTimeoutError();
      const { controller } = build({
        tryReserve: () => Promise.reject(timeout),
        release: () => Promise.reject(timeout),
      });
      const res = fakeResponse();
      const body = await validated(TryReservationDto, {
        lines: [{ variantId: VARIANT_A, quantity: 1 }],
        holdUntil: inAnHour(),
      });
      const run = {
        tryReserve: () => controller.tryReserve(ORDER_ID, body, res as unknown as Response),
        release: () => controller.release(ORDER_ID, res as unknown as Response),
      }[route];

      await expect(run()).rejects.toBe(timeout);
      expect(res.json).not.toHaveBeenCalled();
    },
  );
});
