import { describe, expect, it } from 'vitest';
import { AssetTransitionError, assertTransition, canTransition } from './asset-state-machine';
import { ASSET_STATUSES, AssetStatus } from './asset-status';

// Spelled out again rather than imported: a test that reads the table it checks would agree with
// any typo in it. SWEEPING has no way out on purpose; the sweep's claim is final.
const LEGAL = [
  'ATTACHED->DETACHED',
  'DETACHED->SWEEPING',
  'PENDING->READY',
  'PENDING->SWEEPING',
  'READY->ATTACHED',
  'READY->SWEEPING',
];

describe('asset state machine', () => {
  it('allows exactly the legal edges', () => {
    const allowed = ASSET_STATUSES.flatMap((from) =>
      ASSET_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );

    expect(allowed.sort()).toEqual(LEGAL);
  });

  it('names both ends of a refused transition on the error', () => {
    const refusal = () => assertTransition(AssetStatus.SWEEPING, AssetStatus.ATTACHED);

    expect(refusal).toThrow(AssetTransitionError);
    expect(refusal).toThrow(expect.objectContaining({ from: AssetStatus.SWEEPING, to: AssetStatus.ATTACHED }));
  });
});
