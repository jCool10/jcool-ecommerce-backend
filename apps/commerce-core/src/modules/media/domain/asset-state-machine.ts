import { DomainError } from '@shared/kernel';
import { AssetStatus } from './asset-status';

interface Transition {
  from: AssetStatus;
  to: AssetStatus;
}

const TRANSITIONS: readonly Transition[] = [
  { from: AssetStatus.PENDING, to: AssetStatus.READY }, // the upload was confirmed against the bucket
  { from: AssetStatus.READY, to: AssetStatus.ATTACHED }, // attached to a product, inside that write's tx
  { from: AssetStatus.ATTACHED, to: AssetStatus.DETACHED }, // taken off the product, reclaimable again
  { from: AssetStatus.PENDING, to: AssetStatus.SWEEPING }, // claimed: upload abandoned
  { from: AssetStatus.READY, to: AssetStatus.SWEEPING }, // claimed: uploaded, never attached
  { from: AssetStatus.DETACHED, to: AssetStatus.SWEEPING }, // claimed: no longer in use
];

/**
 * Nothing leaves SWEEPING. That is what makes the sweep safe without holding a row lock across a
 * network call: the claim is committed before the object is deleted, so an attach racing the delete
 * meets a status it cannot transition out of.
 */
const TERMINAL_STATUSES: ReadonlySet<AssetStatus> = new Set([AssetStatus.SWEEPING]);

export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function isTerminal(status: AssetStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class AssetTransitionError extends DomainError {
  constructor(
    readonly from: AssetStatus,
    readonly to: AssetStatus,
  ) {
    super(`Illegal media asset transition: ${from} -> ${to}`);
    this.name = 'AssetTransitionError';
  }
}

export function assertTransition(from: AssetStatus, to: AssetStatus): void {
  if (!canTransition(from, to)) {
    throw new AssetTransitionError(from, to);
  }
}
