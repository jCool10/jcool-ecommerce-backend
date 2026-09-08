import { describe, expect, it } from 'vitest';
import { AssetTransitionError, assertTransition, canTransition, isTerminal } from './asset-state-machine';
import { ASSET_STATUSES, AssetStatus } from './asset-status';

// The legal edges, spelled out again here rather than imported: a test that reads the table it is
// checking would agree with any typo in it.
const LEGAL: [AssetStatus, AssetStatus][] = [
  [AssetStatus.PENDING, AssetStatus.READY],
  [AssetStatus.READY, AssetStatus.ATTACHED],
  [AssetStatus.ATTACHED, AssetStatus.DETACHED],
  [AssetStatus.PENDING, AssetStatus.SWEEPING],
  [AssetStatus.READY, AssetStatus.SWEEPING],
  [AssetStatus.DETACHED, AssetStatus.SWEEPING],
];

describe('asset state machine', () => {
  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('refuses every edge not in the table', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of ASSET_STATUSES) {
      for (const to of ASSET_STATUSES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('lets nothing out of SWEEPING — the claim the sweep committed before deleting the bytes', () => {
    expect(isTerminal(AssetStatus.SWEEPING)).toBe(true);
    for (const to of ASSET_STATUSES) {
      expect(canTransition(AssetStatus.SWEEPING, to)).toBe(false);
    }
  });

  it('names both ends on the error, so a caller can map it without parsing a message', () => {
    try {
      assertTransition(AssetStatus.SWEEPING, AssetStatus.ATTACHED);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetTransitionError);
      expect(error).toMatchObject({ from: AssetStatus.SWEEPING, to: AssetStatus.ATTACHED });
    }
  });

  it('treats a re-attach of an already attached asset as illegal', () => {
    expect(canTransition(AssetStatus.ATTACHED, AssetStatus.ATTACHED)).toBe(false);
  });
});
