/**
 * Order's published settlement language for Payment — a cross-context surface per
 * `.dependency-cruiser.cjs`. Payment decides WHICH outcome a gateway answer means; Order still owns
 * whether that outcome is legal for the order, so what crosses is the vocabulary and the entry
 * point, never the state machine behind them.
 */
import { FinalizeOrderUseCase } from '../use-cases/finalize-order.use-case';
import type { FinalizeOutcome, FinalizeResult, FinalizeStatus } from '../use-cases/finalize-order.types';

// Re-exported explicitly rather than through the use-case barrel: the barrel also carries checkout,
// cancel and the sweeps, which are Order's own internals and must not become Payment's to call.
export { FinalizeOrderUseCase };
export type { FinalizeOutcome, FinalizeResult, FinalizeStatus };
