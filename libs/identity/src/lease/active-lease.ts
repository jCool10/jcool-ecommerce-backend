import type { LeaseHolder } from './lease-holder';

/**
 * Module-level rather than injected, for the reason `identity-clock.collector.ts` keeps its binding
 * that way: the readers — the metrics registry and the readiness probe — are registered once per
 * process and outlive any one app, while `IdentityModule` is per app and not global. An app that
 * holds no lease (commerce-core mints no bucketed ids) simply never sets one.
 */
let active: LeaseHolder | null = null;

export function setActiveLease(holder: LeaseHolder): void {
  active = holder;
}

/** Guarded on identity: an older app's shutdown must not clear a newer app's lease. */
export function clearActiveLease(holder: LeaseHolder): void {
  if (active === holder) active = null;
}

export function activeLease(): LeaseHolder | null {
  return active;
}
