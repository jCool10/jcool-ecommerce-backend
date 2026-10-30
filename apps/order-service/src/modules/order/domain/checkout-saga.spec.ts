import { describe, expect, it } from 'vitest';
import {
  COMPENSATION_REASONS,
  CheckoutStep,
  canCancel,
  finalizeReasonOf,
  initialCheckoutSagaState,
  onAuthorizationVerified,
  onAuthorized,
  onCancelRequested,
  onCaptureResult,
  onCommitResult,
  onCompensationDone,
  onDeadline,
  onLateAuthorizationContext,
  onTryResult,
  planTry,
  toReserveOutcome,
  type CheckoutSagaState,
  type PaymentAuthorization,
  type ReserveOutcome,
  type SagaCommand,
  type Transition,
} from './checkout-saga';
import { OrderStatus } from './order-status';

const EXPECTED = { totalMinor: 250_000, currency: 'VND' };
const AUTH: PaymentAuthorization = {
  paymentId: 'pay-1',
  amountMinor: 250_000,
  currency: 'VND',
  authorizedAt: '2026-03-03T00:05:00.000Z',
};

const types = (commands: readonly SagaCommand[]) => commands.map((command) => command.type);
const compensations = (commands: readonly SagaCommand[]) =>
  commands.flatMap((command) => ('reason' in command && command.type !== 'CHANGE_ORDER' ? [command] : []));
const unchanged = (before: CheckoutSagaState, transition: Transition) => {
  expect(transition.state).toEqual(before);
  expect(transition.commands).toEqual([]);
};

const reserving = () => initialCheckoutSagaState('checkout');
const awaitingAuth = () => onTryResult(reserving(), 'HELD').state;
const committing = () =>
  onAuthorizationVerified(onAuthorized(awaitingAuth(), AUTH, EXPECTED).state, AUTH, 'VERIFIED').state;
const capturing = () => onCommitResult(committing(), 'APPLIED').state;

const finishCompensations = (transition: Transition): CheckoutSagaState =>
  compensations(transition.commands).reduce(
    (state, command) => onCompensationDone(state, command.id).state,
    transition.state,
  );

describe('checkout saga', () => {
  describe('Try', () => {
    it('starts a checkout run at RESERVING and a late-authorization run at COMPENSATING', () => {
      expect(reserving()).toMatchObject({ step: CheckoutStep.RESERVING, orderStatus: OrderStatus.RESERVING });
      expect(initialCheckoutSagaState('lateAuthorization')).toMatchObject({
        step: CheckoutStep.COMPENSATING,
        orderStatus: null,
      });
    });

    it('gives the Try what is left of the budget counted from placedAt, and abandons it at zero', () => {
      const placedAt = '2026-03-03T00:00:00.000Z';
      const placedMs = Date.parse(placedAt);

      expect(planTry({ placedAt, tryTimeoutMs: 3000 }, placedMs + 1000)).toEqual({ abandon: false, timeoutMs: 2000 });
      expect(planTry({ placedAt, tryTimeoutMs: 3000 }, placedMs + 3000)).toEqual({ abandon: true });
      expect(planTry({ placedAt, tryTimeoutMs: 3000 }, placedMs + 4000)).toEqual({ abandon: true });
    });

    it('reports a participant RESERVED as HELD and passes every other answer through', () => {
      expect(toReserveOutcome('RESERVED')).toBe('HELD');
      for (const outcome of ['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const) {
        expect(toReserveOutcome(outcome)).toBe(outcome);
      }
    });

    it('waits for authorization after a hold, with no command', () => {
      const { state, commands } = onTryResult(reserving(), 'HELD');

      expect(state).toMatchObject({
        step: CheckoutStep.AWAITING_AUTH,
        orderStatus: OrderStatus.PENDING,
        tryOutcome: 'HELD',
      });
      expect(commands).toEqual([]);
    });

    const failures: Array<[ReserveOutcome, string]> = [
      ['OUT_OF_STOCK', 'TRY_FAILED'],
      ['CONTENDED', 'TRY_FAILED'],
      ['CONFLICT', 'TRY_FAILED'],
      ['TIMEOUT', 'TRY_TIMEOUT'],
      ['ERROR', 'TRY_TIMEOUT'],
      ['ABANDONED', 'ABANDONED'],
    ];
    it.each(failures)('releases stock after a %s Try, for reason %s', (outcome, reason) => {
      const { state, commands } = onTryResult(reserving(), outcome);

      expect(state).toMatchObject({
        step: CheckoutStep.COMPENSATING,
        orderStatus: OrderStatus.REJECTED,
        tryOutcome: outcome,
      });
      expect(commands).toEqual([{ type: 'RELEASE_STOCK', id: expect.any(Number) as unknown, reason }]);
      expect(state.pending).toEqual(commands);
    });

    it('ignores a second Try result', () => {
      const held = awaitingAuth();
      unchanged(held, onTryResult(held, 'OUT_OF_STOCK'));
    });
  });

  describe('authorization', () => {
    it('asks for verification when amount and currency match, and stays cancellable meanwhile', () => {
      const before = awaitingAuth();

      const { state, commands, ignored } = onAuthorized(before, AUTH, EXPECTED);

      expect(commands).toEqual([{ type: 'VERIFY_AUTHORIZATION', authorization: AUTH }]);
      expect(ignored).toBeNull();
      expect(state.step).toBe(CheckoutStep.AWAITING_AUTH);
      expect(canCancel(state)).toBe(true);
    });

    it('drops a signal whose amount or currency differs from the order, without verifying it', () => {
      const before = awaitingAuth();

      for (const signal of [
        { ...AUTH, amountMinor: 1 },
        { ...AUTH, currency: 'USD' },
      ]) {
        const transition = onAuthorized(before, signal, EXPECTED);
        unchanged(before, transition);
        expect(transition.ignored).toBe('AMOUNT_MISMATCH');
      }
    });

    it('verifies one paymentId only once while its verification is in flight', () => {
      const asked = onAuthorized(awaitingAuth(), AUTH, EXPECTED).state;

      unchanged(asked, onAuthorized(asked, AUTH, EXPECTED));
      expect(types(onAuthorized(asked, { ...AUTH, paymentId: 'pay-2' }, EXPECTED).commands)).toEqual([
        'VERIFY_AUTHORIZATION',
      ]);
    });

    it('confirms the order and commits stock once the authorization is verified', () => {
      const asked = onAuthorized(awaitingAuth(), AUTH, EXPECTED).state;

      const { state, commands, ignored } = onAuthorizationVerified(asked, AUTH, 'VERIFIED');

      expect(ignored).toBeNull();
      expect(state).toMatchObject({
        step: CheckoutStep.COMMITTING_STOCK,
        orderStatus: OrderStatus.CONFIRMING,
        authorization: AUTH,
      });
      expect(commands).toEqual([
        { type: 'CHANGE_ORDER', from: [OrderStatus.PENDING], to: OrderStatus.CONFIRMING, reason: null },
        { type: 'COMMIT_STOCK' },
      ]);
      expect(canCancel(state)).toBe(false);
    });

    it.each(['NOT_AUTHORIZED', 'PAYMENT_MISMATCH'] as const)('drops a %s verdict and keeps waiting', (verdict) => {
      const asked = onAuthorized(awaitingAuth(), AUTH, EXPECTED).state;

      const { state, commands, ignored } = onAuthorizationVerified(asked, AUTH, verdict);

      expect(ignored).toBe(verdict);
      expect(commands).toEqual([]);
      expect(state.step).toBe(CheckoutStep.AWAITING_AUTH);
      // The real authorization may still come under the same paymentId.
      expect(types(onAuthorized(state, AUTH, EXPECTED).commands)).toEqual(['VERIFY_AUTHORIZATION']);
    });

    it('lets a cancel or the deadline beat a verification still in flight', () => {
      const asked = onAuthorized(awaitingAuth(), AUTH, EXPECTED).state;

      for (const lost of [onCancelRequested(asked, 'buyer').state, onDeadline(asked).state]) {
        const transition = onAuthorizationVerified(lost, AUTH, 'VERIFIED');
        unchanged(lost, transition);
        expect(transition.ignored).toBeNull();
        expect(types(lost.pending)).toContain('CANCEL_PAYMENT');
      }
    });

    it('voids an authorization that lands while compensating, once per paymentId and without verifying', () => {
      const compensating = onTryResult(reserving(), 'OUT_OF_STOCK').state;

      const { state, commands } = onAuthorized(compensating, { ...AUTH, amountMinor: 1 }, EXPECTED);

      expect(commands).toEqual([
        { type: 'CANCEL_PAYMENT', id: expect.any(Number) as unknown, reason: 'LATE_AUTHORIZATION' },
      ]);
      expect(state.step).toBe(CheckoutStep.COMPENSATING);
      unchanged(state, onAuthorized(state, AUTH, EXPECTED));
    });

    it('reopens compensation for an authorization landing after it finished', () => {
      const done = finishCompensations(onTryResult(reserving(), 'OUT_OF_STOCK'));
      expect(done.step).toBe(CheckoutStep.COMPENSATED);

      const { state, commands } = onAuthorized(done, AUTH, EXPECTED);

      expect(state.step).toBe(CheckoutStep.COMPENSATING);
      expect(types(commands)).toEqual(['CANCEL_PAYMENT']);
    });

    it('ignores authorization while the order is past the point of waiting for one', () => {
      for (const state of [committing(), capturing(), onCaptureResult(capturing(), 'CAPTURED').state]) {
        unchanged(state, onAuthorized(state, { ...AUTH, paymentId: 'pay-2' }, EXPECTED));
      }
    });
  });

  describe('commit and capture', () => {
    it.each(['APPLIED', 'IDEMPOTENT'] as const)('captures after a %s commit', (outcome) => {
      const { state, commands } = onCommitResult(committing(), outcome);

      expect(state.step).toBe(CheckoutStep.CAPTURING);
      expect(commands).toEqual([{ type: 'CAPTURE_PAYMENT' }]);
    });

    it('fails the order and voids the payment when the commit conflicts', () => {
      const { state, commands } = onCommitResult(committing(), 'CONFLICT');

      expect(state).toMatchObject({ step: CheckoutStep.COMPENSATING, orderStatus: OrderStatus.FAILED });
      expect(commands).toEqual([
        {
          type: 'CHANGE_ORDER',
          from: [OrderStatus.CONFIRMING],
          to: OrderStatus.FAILED,
          reason: 'saga:commit_conflict',
        },
        { type: 'CANCEL_PAYMENT', id: expect.any(Number) as unknown, reason: 'COMMIT_CONFLICT' },
      ]);
    });

    it.each(['CAPTURED', 'IDEMPOTENT'] as const)('pays the order after a %s capture', (outcome) => {
      const { state, commands } = onCaptureResult(capturing(), outcome);

      expect(state).toMatchObject({ step: CheckoutStep.COMPLETED, orderStatus: OrderStatus.PAID });
      expect(commands).toEqual([
        {
          type: 'CHANGE_ORDER',
          from: [OrderStatus.CONFIRMING],
          to: OrderStatus.PAID,
          reason: 'saga:captured',
          paymentRef: AUTH.paymentId,
        },
      ]);
    });

    it('fails the order, restocks and voids when the hold can no longer be captured', () => {
      const { state, commands } = onCaptureResult(capturing(), 'NOT_CAPTURABLE');

      expect(state).toMatchObject({ step: CheckoutStep.COMPENSATING, orderStatus: OrderStatus.FAILED });
      expect(types(commands)).toEqual(['CHANGE_ORDER', 'RESTOCK', 'CANCEL_PAYMENT']);
      expect(compensations(commands).map((command) => command.reason)).toEqual(['CAPTURE_FAILED', 'CAPTURE_FAILED']);
    });

    it('ignores a repeated commit or capture result', () => {
      const captured = capturing();
      unchanged(captured, onCommitResult(captured, 'APPLIED'));
      const paid = onCaptureResult(captured, 'CAPTURED').state;
      unchanged(paid, onCaptureResult(paid, 'CAPTURED'));
    });
  });

  describe('cancel and deadline', () => {
    it.each([
      ['buyer', 'user:cancel'],
      ['admin', 'admin:cancel'],
    ] as const)('cancels for the %s, releasing stock and voiding the payment', (by, reason) => {
      const { state, commands } = onCancelRequested(awaitingAuth(), by);

      expect(state).toMatchObject({ step: CheckoutStep.COMPENSATING, orderStatus: OrderStatus.CANCELLED });
      expect(commands[0]).toEqual({
        type: 'CHANGE_ORDER',
        from: [OrderStatus.PENDING],
        to: OrderStatus.CANCELLED,
        reason,
      });
      expect(compensations(commands).map(({ type, reason: why }) => [type, why])).toEqual([
        ['RELEASE_STOCK', 'CANCELLED'],
        ['CANCEL_PAYMENT', 'CANCELLED'],
      ]);
    });

    it('treats a repeated cancel as already done and keeps accepting it', () => {
      const cancelled = onCancelRequested(awaitingAuth(), 'buyer').state;

      unchanged(cancelled, onCancelRequested(cancelled, 'buyer'));
      expect(canCancel(cancelled)).toBe(true);
    });

    it('expires an order nobody paid, releasing stock and voiding the payment', () => {
      const { state, commands } = onDeadline(awaitingAuth());

      expect(state).toMatchObject({ step: CheckoutStep.COMPENSATING, orderStatus: OrderStatus.EXPIRED });
      expect(commands[0]).toEqual({
        type: 'CHANGE_ORDER',
        from: [OrderStatus.PENDING],
        to: OrderStatus.EXPIRED,
        reason: 'saga:expired',
      });
      expect(compensations(commands).map(({ type, reason }) => [type, reason])).toEqual([
        ['RELEASE_STOCK', 'EXPIRED'],
        ['CANCEL_PAYMENT', 'EXPIRED'],
      ]);
    });

    it('lets the deadline pass once confirming has started', () => {
      for (const state of [committing(), capturing()]) {
        unchanged(state, onDeadline(state));
      }
      const expired = onDeadline(awaitingAuth()).state;
      unchanged(expired, onDeadline(expired));
    });

    it('accepts a cancel only while waiting for authorization or once already cancelled', () => {
      const failed = onTryResult(reserving(), 'OUT_OF_STOCK').state;
      const expectations: Array<[CheckoutSagaState, boolean]> = [
        [reserving(), false],
        [awaitingAuth(), true],
        [committing(), false],
        [capturing(), false],
        [onCaptureResult(capturing(), 'CAPTURED').state, false],
        [failed, false],
        [finishCompensations({ state: failed, commands: failed.pending }), false],
        [onDeadline(awaitingAuth()).state, false],
        [onCancelRequested(awaitingAuth(), 'admin').state, true],
      ];
      for (const [state, allowed] of expectations) {
        expect(canCancel(state), state.step).toBe(allowed);
      }
    });
  });

  describe('compensation', () => {
    it('ends COMPENSATED only once every compensation has answered', () => {
      const transition = onCancelRequested(awaitingAuth(), 'buyer');
      const [release, cancel] = compensations(transition.commands);

      const half = onCompensationDone(transition.state, release.id).state;
      expect(half.step).toBe(CheckoutStep.COMPENSATING);
      expect(half.pending).toEqual([cancel]);

      const done = onCompensationDone(half, cancel.id);
      expect(done.state.step).toBe(CheckoutStep.COMPENSATED);
      expect(done.commands).toEqual([]);
      unchanged(done.state, onCompensationDone(done.state, cancel.id));
    });

    it('carries the reason each compensation was issued for', () => {
      expect(COMPENSATION_REASONS).toEqual([
        'TRY_FAILED',
        'TRY_TIMEOUT',
        'ABANDONED',
        'EXPIRED',
        'CANCELLED',
        'COMMIT_CONFLICT',
        'CAPTURE_FAILED',
        'LATE_AUTHORIZATION',
      ]);
      expect(finalizeReasonOf('TRY_TIMEOUT')).toBe('saga:try_timeout');
    });
  });

  describe('late authorization run', () => {
    const lateRun = () => onAuthorized(initialCheckoutSagaState('lateAuthorization'), AUTH, EXPECTED).state;

    it('waits for the order before voiding anything', () => {
      const { commands } = onAuthorized(initialCheckoutSagaState('lateAuthorization'), AUTH, EXPECTED);

      expect(commands).toEqual([]);
    });

    it('leaves a paid order alone', () => {
      const { state, commands } = onLateAuthorizationContext(lateRun(), OrderStatus.PAID);

      expect(state.step).toBe(CheckoutStep.COMPLETED);
      expect(commands).toEqual([]);
    });

    it.each([
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.FAILED,
      OrderStatus.REJECTED,
      OrderStatus.PENDING,
      null,
    ])('voids the payment of an order in %s without touching the order', (status) => {
      const { state, commands } = onLateAuthorizationContext(lateRun(), status);

      expect(state.step).toBe(CheckoutStep.COMPENSATING);
      expect(commands).toEqual([
        { type: 'CANCEL_PAYMENT', id: expect.any(Number) as unknown, reason: 'LATE_AUTHORIZATION' },
      ]);
      expect(finishCompensations({ state, commands }).step).toBe(CheckoutStep.COMPENSATED);
    });
  });
});
