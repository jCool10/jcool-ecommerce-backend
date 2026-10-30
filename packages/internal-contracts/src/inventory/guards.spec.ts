import {
  commandOutcomeOf,
  isCommandResponse,
  isLockBudgetExhausted,
  isStatusResponse,
  isTryReservationResponse,
  statusesOf,
  tryOutcomeOf,
} from './guards';
import { COMMAND_OUTCOME_STATUS, TRY_OUTCOME_STATUS, reservationRoutes } from './routes';
import { COMMAND_OUTCOMES, LOCK_BUDGET_EXHAUSTED, TRY_OUTCOMES } from './types';

describe('inventory response guards', () => {
  it.each(TRY_OUTCOMES)('accepts a Try answered %s', (outcome) => {
    expect(isTryReservationResponse({ outcome })).toBe(true);
  });

  it.each([null, 'RESERVED', [], {}, { outcome: 'APPLIED' }, { outcome: 'reserved' }, { outcome: 1 }])(
    'refuses %j as a Try answer',
    (body) => {
      expect(isTryReservationResponse(body)).toBe(false);
    },
  );

  it.each(COMMAND_OUTCOMES)('accepts a command answered %s', (outcome) => {
    expect(isCommandResponse({ outcome })).toBe(true);
  });

  it.each([undefined, { outcome: 'RESERVED' }, { outcome: null }, { result: 'APPLIED' }])(
    'refuses %j as a command answer',
    (body) => {
      expect(isCommandResponse(body)).toBe(false);
    },
  );

  it('accepts statuses that are each a header or null', () => {
    expect(isStatusResponse({ statuses: {} })).toBe(true);
    expect(isStatusResponse({ statuses: { '1': 'HELD', '2': null } })).toBe(true);
  });

  it.each([{}, { statuses: [] }, { statuses: null }, { statuses: { '1': 'PAID' } }, { statuses: { '1': undefined } }])(
    'refuses %j as a status answer',
    (body) => {
      expect(isStatusResponse(body)).toBe(false);
    },
  );
});

describe('outcome and status code', () => {
  it('maps a Try to 201 only when it holds', () => {
    expect(TRY_OUTCOME_STATUS).toEqual({ RESERVED: 201, OUT_OF_STOCK: 409, CONTENDED: 409, CONFLICT: 409 });
  });

  it('maps a command to 409 only on conflict', () => {
    expect(COMMAND_OUTCOME_STATUS).toEqual({ APPLIED: 200, IDEMPOTENT: 200, CONFLICT: 409 });
  });

  it('reads an outcome only when the status code agrees with it', () => {
    expect(tryOutcomeOf(201, { outcome: 'RESERVED' })).toBe('RESERVED');
    expect(tryOutcomeOf(409, { outcome: 'CONTENDED' })).toBe('CONTENDED');
    expect(tryOutcomeOf(200, { outcome: 'RESERVED' })).toBeUndefined();
    expect(tryOutcomeOf(201, { outcome: 'OUT_OF_STOCK' })).toBeUndefined();
    expect(tryOutcomeOf(409, { message: 'Conflict' })).toBeUndefined();

    expect(commandOutcomeOf(200, { outcome: 'IDEMPOTENT' })).toBe('IDEMPOTENT');
    expect(commandOutcomeOf(409, { outcome: 'CONFLICT' })).toBe('CONFLICT');
    expect(commandOutcomeOf(409, { outcome: 'APPLIED' })).toBeUndefined();
    expect(commandOutcomeOf(201, { outcome: 'APPLIED' })).toBeUndefined();
  });

  it('reads statuses only when every id asked for is answered', () => {
    expect(statusesOf({ statuses: { '1': 'HELD', '2': null } }, ['1', '2'])).toEqual(
      new Map([
        ['1', 'HELD'],
        ['2', null],
      ]),
    );
    expect(statusesOf({ statuses: { '1': 'HELD' } }, ['1', '2'])).toBeUndefined();
    expect(statusesOf({ statuses: { '1': 'LOST' } }, ['1'])).toBeUndefined();
  });

  it('only asks for what was named', () => {
    expect(statusesOf({ statuses: { '1': 'HELD', '9': 'FENCED' } }, ['1'])).toEqual(new Map([['1', 'HELD']]));
  });

  it('reads busy rows only from a 503 that carries their code', () => {
    const busy = { statusCode: 503, code: LOCK_BUDGET_EXHAUSTED, message: 'Service unavailable' };

    expect(isLockBudgetExhausted(503, busy)).toBe(true);
    expect(isLockBudgetExhausted(503, { statusCode: 503, message: 'Service unavailable' })).toBe(false);
    expect(isLockBudgetExhausted(503, { code: 'LEASE_NOT_HELD' })).toBe(false);
    expect(isLockBudgetExhausted(503, null)).toBe(false);
    expect(isLockBudgetExhausted(500, busy)).toBe(false);
    expect(isLockBudgetExhausted(409, busy)).toBe(false);
  });
});

describe('reservationRoutes', () => {
  it('puts the order id in the path, encoded', () => {
    expect(reservationRoutes.try('42')).toBe('/internal/v1/reservations/42/try');
    expect(reservationRoutes.command('42', 'restock')).toBe('/internal/v1/reservations/42/restock');
    expect(reservationRoutes.command('a/b', 'commit')).toBe('/internal/v1/reservations/a%2Fb/commit');
    expect(reservationRoutes.status).toBe('/internal/v1/reservations/status');
  });
});
