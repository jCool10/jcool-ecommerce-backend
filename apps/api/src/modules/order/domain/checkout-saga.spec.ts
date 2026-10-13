import { describe, expect, it } from 'vitest';
import { CheckoutSagaStep, Compensation } from './checkout-saga-step';
import {
  onAuthorized,
  onCancelRequested,
  onCaptureResult,
  onCommitResult,
  onCompensationResults,
  onDeadline,
  onTryResult,
  type CompensationResult,
  type SagaState,
} from './checkout-saga';

const { RESERVING, AWAITING_AUTH, COMMITTING_STOCK, CAPTURING, COMPLETED, COMPENSATING, COMPENSATED } =
  CheckoutSagaStep;
const { RELEASE_STOCK, RESTOCK, CANCEL_PAYMENT } = Compensation;

const saga = (step: SagaState['step'], pendingCompensations: Compensation[] = []): SagaState => ({
  step,
  pendingCompensations,
});

const done: CompensationResult = { kind: 'done' };

describe('checkout saga transitions', () => {
  describe('onTryResult', () => {
    it('parks a HELD order on AWAITING_AUTH and places it', () => {
      expect(onTryResult('HELD')).toEqual({
        step: AWAITING_AUTH,
        pendingCompensations: [],
        order: { status: 'PENDING' },
        cause: null,
      });
    });

    it.each(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const)(
      'rejects on a final %s with nothing left to undo',
      (verdict) => {
        expect(onTryResult(verdict)).toEqual({
          step: COMPENSATED,
          pendingCompensations: [],
          order: { status: 'REJECTED', reason: `try:${verdict.toLowerCase()}` },
          cause: null,
        });
      },
    );

    it.each(['TIMEOUT', 'ERROR', 'ABANDONED'] as const)(
      'rejects on an unknown %s and releases whatever the Try may have held',
      (verdict) => {
        expect(onTryResult(verdict)).toEqual({
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK],
          order: { status: 'REJECTED', reason: `try:${verdict.toLowerCase()}` },
          cause: 'try_failed',
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
          order: { status: 'CONFIRMING' },
          cause: null,
        },
      });
    });

    it('fails a parked order whose authorization does not match, voiding the money and releasing the stock', () => {
      expect(onAuthorized(saga(AWAITING_AUTH), false)).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
          order: { status: 'FAILED', reason: 'payment:amount_mismatch' },
          cause: 'amount_mismatch',
        },
      });
    });

    it('reopens a compensated saga to void money that arrived too late', () => {
      expect(onAuthorized(saga(COMPENSATED), true)).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [CANCEL_PAYMENT],
          order: null,
          cause: 'late_authorization',
        },
      });
    });

    it('adds the void to a compensation still running, keeping what is left of it', () => {
      expect(onAuthorized(saga(COMPENSATING, [RESTOCK]), true)).toMatchObject({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
          cause: 'late_authorization',
        },
      });
    });

    it('keeps a compensation that already voids, without counting a second late authorization', () => {
      expect(onAuthorized(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), false)).toEqual({
        kind: 'apply',
        transition: {
          step: COMPENSATING,
          pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
          order: null,
          cause: null,
        },
      });
    });

    it.each([COMMITTING_STOCK, CAPTURING, COMPLETED])('ignores a duplicate authorization at %s', (step) => {
      expect(onAuthorized(saga(step), true)).toEqual({ kind: 'duplicate' });
    });

    it('defers an authorization that overtook the Try', () => {
      expect(onAuthorized(saga(RESERVING), true)).toEqual({ kind: 'premature' });
    });
  });

  describe('onCommitResult', () => {
    it('moves on to capture once the stock is committed', () => {
      expect(onCommitResult('COMMITTED')).toEqual({
        step: CAPTURING,
        pendingCompensations: [],
        order: null,
        cause: null,
      });
    });

    it('fails the order and voids the money when the hold is gone', () => {
      expect(onCommitResult('CONFLICT')).toEqual({
        step: COMPENSATING,
        pendingCompensations: [CANCEL_PAYMENT],
        order: { status: 'FAILED', reason: 'stock:commit_conflict' },
        cause: 'commit_conflict',
      });
    });
  });

  describe('onCaptureResult', () => {
    it('pays the order once the money is captured', () => {
      expect(onCaptureResult('CAPTURED')).toEqual({
        step: COMPLETED,
        pendingCompensations: [],
        order: { status: 'PAID', reason: 'payment:captured' },
        cause: null,
      });
    });

    it('fails the order, puts the stock back and voids when the money cannot be captured', () => {
      expect(onCaptureResult('NOT_CAPTURABLE')).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
        order: { status: 'FAILED', reason: 'payment:not_capturable' },
        cause: 'capture_failed',
      });
    });
  });

  describe('onDeadline', () => {
    const graceEnds = new Date('2026-03-01T10:03:00.000Z');

    it('keeps a saga parked one second before the authorization grace runs out', () => {
      expect(onDeadline(new Date(graceEnds.getTime() - 1_000), graceEnds)).toEqual({
        step: AWAITING_AUTH,
        pendingCompensations: [],
        order: null,
        cause: null,
      });
    });

    it('expires the order exactly when the grace runs out, releasing stock and closing the session', () => {
      expect(onDeadline(graceEnds, graceEnds)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
        order: { status: 'EXPIRED', reason: 'saga:deadline' },
        cause: 'expired',
      });
    });
  });

  describe('onCancelRequested', () => {
    it.each(['user', 'admin'] as const)('cancels for the %s, releasing stock and closing the session', (by) => {
      expect(onCancelRequested(saga(AWAITING_AUTH), by)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
        order: { status: 'CANCELLED', reason: `${by}:cancel` },
        cause: 'cancelled',
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
        order: null,
        cause: null,
      });
    });

    it('completes an empty set straight away', () => {
      expect(onCompensationResults(saga(COMPENSATING, []), new Map())).toMatchObject({ step: COMPENSATED });
    });

    it('drops the steps that succeeded even when another one failed', () => {
      const results = new Map<Compensation, CompensationResult>([
        [RELEASE_STOCK, done],
        [CANCEL_PAYMENT, { kind: 'failed', detail: 'gateway unavailable' }],
      ]);

      expect(onCompensationResults(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), results)).toEqual({
        step: COMPENSATING,
        pendingCompensations: [CANCEL_PAYMENT],
        order: null,
        cause: null,
      });
    });

    it('stays compensating on a conflict', () => {
      const results = new Map<Compensation, CompensationResult>([
        [RESTOCK, { kind: 'conflict', detail: 'header RELEASED' }],
        [CANCEL_PAYMENT, { kind: 'conflict', detail: 'CAPTURED_CONFLICT' }],
      ]);

      expect(onCompensationResults(saga(COMPENSATING, [RESTOCK, CANCEL_PAYMENT]), results)).toMatchObject({
        step: COMPENSATING,
        pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
      });
    });

    it('keeps a step it has no result for', () => {
      const results = new Map<Compensation, CompensationResult>([[RELEASE_STOCK, done]]);

      expect(
        onCompensationResults(saga(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT]), results).pendingCompensations,
      ).toEqual([CANCEL_PAYMENT]);
    });
  });
});
