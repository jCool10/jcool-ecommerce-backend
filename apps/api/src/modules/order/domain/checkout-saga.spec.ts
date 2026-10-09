import { describe, expect, it } from 'vitest';
import { CheckoutSagaStep, Compensation } from './checkout-saga-step';
import {
  nextDelay,
  onAuthorized,
  onCancelRequested,
  onCaptureResult,
  onCommitResult,
  onCompensationResults,
  onDeadline,
  onStepFailed,
  onTryResult,
  scheduleNext,
  type CompensationResult,
  type SagaState,
  type SagaTiming,
} from './checkout-saga';

const { RESERVING, AWAITING_AUTH, COMMITTING_STOCK, CAPTURING, COMPLETED, COMPENSATING, COMPENSATED } =
  CheckoutSagaStep;
const { RELEASE_STOCK, RESTOCK, CANCEL_PAYMENT } = Compensation;

const timing: SagaTiming = { authGraceMs: 180_000, retryBaseMs: 1_000, retryCapMs: 300_000 };
const deadlineAt = new Date('2026-03-01T10:00:00.000Z');
const now = new Date('2026-03-01T09:30:00.000Z');

const saga = (step: SagaState['step'], pendingCompensations: Compensation[] = [], attempts = 0): SagaState => ({
  step,
  pendingCompensations,
  deadlineAt,
  attempts,
});

const done: CompensationResult = { kind: 'done' };

describe('checkout saga transitions', () => {
  describe('onTryResult', () => {
    it('parks a HELD order on AWAITING_AUTH and places it', () => {
      expect(onTryResult('HELD')).toEqual({
        step: AWAITING_AUTH,
        pendingCompensations: [],
        wake: 'park',
        order: { status: 'PENDING' },
        cause: null,
        lastError: null,
      });
    });

    it.each(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const)(
      'rejects on a final %s with nothing left to undo',
      (verdict) => {
        expect(onTryResult(verdict)).toEqual({
          step: COMPENSATED,
          pendingCompensations: [],
          wake: 'done',
          order: { status: 'REJECTED', reason: `try:${verdict.toLowerCase()}` },
          cause: null,
          lastError: null,
        });
      },
    );

    it.each(['TIMEOUT', 'ERROR', 'ABANDONED'] as const)(
      'rejects on an unknown %s and releases whatever the Try may have held',
      (verdict) => {
        expect(onTryResult(verdict)).toEqual({
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK],
          wake: 'now',
          order: { status: 'REJECTED', reason: `try:${verdict.toLowerCase()}` },
          cause: 'try_failed',
          lastError: null,
        });
      },
    );
  });

  describe('onAuthorized', () => {
    it('confirms a parked order whose authorization matches its total', () => {
      expect(onAuthorized(saga(AWAITING_AUTH), true)).toEqual({
        kind: 'apply',
        transition: {
          step: COMMITTING_STOCK,
          pendingCompensations: [],
          wake: 'now',
          order: { status: 'CONFIRMING' },
          cause: null,
          lastError: null,
        },
      });
    });

    it('fails a parked order whose authorization does not match, voiding the money and releasing the stock', () => {
      expect(onAuthorized(saga(AWAITING_AUTH), false)).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
          wake: 'now',
          order: { status: 'FAILED', reason: 'payment:amount_mismatch' },
          cause: 'amount_mismatch',
          lastError: null,
        },
      });
    });

    it('reopens a compensated saga to void money that arrived too late', () => {
      expect(onAuthorized(saga(COMPENSATED), true)).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [CANCEL_PAYMENT],
          wake: 'now',
          order: null,
          cause: 'late_authorization',
          lastError: null,
        },
      });
    });

    it('adds the void to a compensation still running, keeping what is left of it', () => {
      const decision = onAuthorized(saga(COMPENSATING, [RESTOCK], 4), true);

      expect(decision).toMatchObject({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
          cause: 'late_authorization',
        },
      });
    });

    it('still rewrites a compensation that already voids, without counting a second late authorization', () => {
      const decision = onAuthorized(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), false);

      expect(decision).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
          wake: 'now',
          order: null,
          cause: null,
          lastError: null,
        },
      });
    });

    it.each([COMMITTING_STOCK, CAPTURING, COMPLETED])('ignores a duplicate authorization at %s', (step) => {
      expect(onAuthorized(saga(step), true)).toEqual({ kind: 'duplicate' });
    });

    it('defers an authorization that overtook the Try, which cannot happen unless something is badly out of order', () => {
      expect(onAuthorized(saga(RESERVING), true)).toEqual({ kind: 'premature' });
    });
  });

  describe('onCommitResult', () => {
    it('moves on to capture once the stock is committed', () => {
      expect(onCommitResult('COMMITTED')).toEqual({
        step: CAPTURING,
        pendingCompensations: [],
        wake: 'now',
        order: null,
        cause: null,
        lastError: null,
      });
    });

    it('fails the order and voids the money when the hold is gone', () => {
      expect(onCommitResult('CONFLICT')).toEqual({
        step: COMPENSATING,
        pendingCompensations: [CANCEL_PAYMENT],
        wake: 'now',
        order: { status: 'FAILED', reason: 'stock:commit_conflict' },
        cause: 'commit_conflict',
        lastError: null,
      });
    });
  });

  describe('onCaptureResult', () => {
    it('pays the order once the money is captured', () => {
      expect(onCaptureResult('CAPTURED')).toEqual({
        step: COMPLETED,
        pendingCompensations: [],
        wake: 'done',
        order: { status: 'PAID', reason: 'payment:captured' },
        cause: null,
        lastError: null,
      });
    });

    it('fails the order, puts the stock back and voids when the money cannot be captured', () => {
      expect(onCaptureResult('NOT_CAPTURABLE')).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
        wake: 'now',
        order: { status: 'FAILED', reason: 'payment:not_capturable' },
        cause: 'capture_failed',
        lastError: null,
      });
    });
  });

  describe('onStepFailed', () => {
    it('retries a capture with no answer on the same step and never compensates', () => {
      expect(onStepFailed(saga(CAPTURING, [], 2), 'gateway timeout')).toEqual({
        step: CAPTURING,
        pendingCompensations: [],
        wake: 'backoff',
        order: null,
        cause: null,
        lastError: 'gateway timeout',
      });
    });
  });

  describe('onDeadline', () => {
    const graceEnds = new Date(deadlineAt.getTime() + timing.authGraceMs);

    it('keeps a saga parked one second before the authorization grace runs out', () => {
      expect(onDeadline(saga(AWAITING_AUTH), new Date(graceEnds.getTime() - 1_000), timing)).toEqual({
        step: AWAITING_AUTH,
        pendingCompensations: [],
        wake: 'park',
        order: null,
        cause: null,
        lastError: null,
      });
    });

    it('expires the order exactly when the grace runs out, releasing stock and closing the session', () => {
      expect(onDeadline(saga(AWAITING_AUTH), graceEnds, timing)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
        wake: 'now',
        order: { status: 'EXPIRED', reason: 'saga:deadline' },
        cause: 'expired',
        lastError: null,
      });
    });
  });

  describe('onCancelRequested', () => {
    it.each(['user', 'admin'] as const)('cancels for the %s, releasing stock and closing the session', (by) => {
      expect(onCancelRequested(saga(AWAITING_AUTH), by)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
        wake: 'now',
        order: { status: 'CANCELLED', reason: `${by}:cancel` },
        cause: 'cancelled',
        lastError: null,
      });
    });

    it('refuses a saga that is no longer waiting for the buyer', () => {
      expect(() => onCancelRequested(saga(COMMITTING_STOCK), 'user')).toThrow(/COMMITTING_STOCK/);
    });
  });

  describe('onCompensationResults', () => {
    it('completes the compensation once every step in the set is done', () => {
      const results = new Map([
        [RELEASE_STOCK, done],
        [CANCEL_PAYMENT, done],
      ]);

      expect(onCompensationResults(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), results)).toEqual({
        step: COMPENSATED,
        pendingCompensations: [],
        wake: 'done',
        order: null,
        cause: null,
        lastError: null,
      });
    });

    it('completes an empty set straight away', () => {
      expect(onCompensationResults(saga(COMPENSATING, []), new Map())).toMatchObject({
        step: COMPENSATED,
        wake: 'done',
      });
    });

    it('drops the steps that succeeded even when another one failed, and backs off for the rest', () => {
      const results = new Map<Compensation, CompensationResult>([
        [RELEASE_STOCK, done],
        [CANCEL_PAYMENT, { kind: 'failed', detail: 'gateway unavailable' }],
      ]);

      expect(onCompensationResults(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), results)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [CANCEL_PAYMENT],
        wake: 'backoff',
        order: null,
        cause: null,
        lastError: 'CANCEL_PAYMENT: gateway unavailable',
      });
    });

    it('stays compensating on a conflict and records it for whoever has to look', () => {
      const results = new Map<Compensation, CompensationResult>([
        [RESTOCK, { kind: 'conflict', detail: 'header RELEASED' }],
        [CANCEL_PAYMENT, { kind: 'conflict', detail: 'CAPTURED_CONFLICT' }],
      ]);

      expect(onCompensationResults(saga(COMPENSATING, [RESTOCK, CANCEL_PAYMENT]), results)).toMatchObject({
        step: COMPENSATING,
        pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
        wake: 'backoff',
        lastError: 'RESTOCK: header RELEASED; CANCEL_PAYMENT: CAPTURED_CONFLICT',
      });
    });

    it('keeps a step it has no result for', () => {
      const results = new Map<Compensation, CompensationResult>([[RELEASE_STOCK, done]]);

      expect(
        onCompensationResults(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), results).pendingCompensations,
      ).toEqual([CANCEL_PAYMENT]);
    });
  });

  describe('scheduling', () => {
    it('doubles the delay per attempt up to the cap', () => {
      expect([0, 1, 2, 3].map((attempts) => nextDelay(attempts, timing))).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(nextDelay(9, timing)).toBe(300_000);
      expect(nextDelay(10_000, timing)).toBe(300_000);
    });

    it('wakes a step with work right away and resets the attempts', () => {
      expect(scheduleNext('now', saga(CAPTURING, [], 5), now, timing)).toEqual({ nextAttemptAt: now, attempts: 0 });
    });

    it('wakes a parked saga when the authorization grace runs out', () => {
      expect(scheduleNext('park', saga(AWAITING_AUTH, [], 3), now, timing)).toEqual({
        nextAttemptAt: new Date(deadlineAt.getTime() + timing.authGraceMs),
        attempts: 0,
      });
    });

    it('backs off from the attempts already spent and counts this one', () => {
      expect(scheduleNext('backoff', saga(CAPTURING, [], 2), now, timing)).toEqual({
        nextAttemptAt: new Date(now.getTime() + 4_000),
        attempts: 3,
      });
    });

    it('resets the attempts on a terminal step', () => {
      expect(scheduleNext('done', saga(COMPENSATING, [], 7), now, timing)).toEqual({ nextAttemptAt: now, attempts: 0 });
    });
  });
});
